import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { axeClean } from '../../test-utils/axe.js';
import Clients from '../Clients.jsx';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { ConfirmProvider } from '../ui/confirm.jsx';

// Mock the data + write layer. This file covers the B5 "Health" cell AND the C5
// ifRev concurrency + hardened logo upload (echo the read rev on save; a picked
// image file flows through uploadAssetFile and is stored as {path,url}, never the
// broken {file} shape; an upload failure surfaces an inline banner).
let clientsState;
// The joined health/in-flight roll-up; per-test rows drive the A4 archive-safety
// confirm (row.inFlight) as well as the B5 health cell.
let overviewState;
const updateClient = vi.fn(() => Promise.resolve({ ok: true, rev: 'new000000000' }));
const uploadAssetFile = vi.fn(() => Promise.resolve({ ok: true, file: 'logo.png' }));
const archiveClient = vi.fn(() => Promise.resolve({ ok: true }));
// make-active routes through the shared useSetActiveClient() hook (single
// CLIENT_SCOPED_KEYS source of truth), so the mock exposes that hook, not the
// raw setActiveClient. setActive is the function the hook returns.
const setActive = vi.fn(() => Promise.resolve({ ok: true }));

vi.mock('../../lib/api.js', () => ({
  usePlansAll: (clients) => (clients || []).map(() => ({ data: undefined, isLoading: true })),
  useClients: () => ({ data: clientsState, isLoading: false, isError: false, error: null }),
  useClientsOverview: () => ({ data: overviewState, isLoading: false, isError: false, error: null }),
  createClient: vi.fn(() => Promise.resolve({ ok: true })),
  updateClient: (...args) => updateClient(...args),
  archiveClient: (...args) => archiveClient(...args),
  useSetActiveClient: () => setActive,
  uploadAssetFile: (...args) => uploadAssetFile(...args),
  // Client review link (spec 48 R10): the ReviewSection Clients now renders for the
  // active project pulls these. Stubbed inert so this file stays focused on the
  // admin table / form; the review UI has its own dedicated tests.
  useReviewers: () => ({ data: { reviewers: [] }, isLoading: false }),
  useConfig: () => ({ data: { rev: 'r1', posting: { review: { required: false, hosted: false, contact: null } } } }),
  saveConfig: vi.fn(() => Promise.resolve({ ok: true })),
  createReviewer: vi.fn(() => Promise.resolve({ ok: true, token: 't', reviewer: {} })),
  revokeReviewer: vi.fn(() => Promise.resolve({ ok: true })),
}));

function renderClients() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <TooltipProvider>
        <ConfirmProvider>
          <Clients />
        </ConfirmProvider>
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  updateClient.mockClear();
  uploadAssetFile.mockClear();
  archiveClient.mockClear();
  archiveClient.mockImplementation(() => Promise.resolve({ ok: true }));
  setActive.mockClear();
  // C4 read-only overview: stub empty by default so unrelated assertions stay
  // focused on the admin table / form behavior.
  overviewState = { clients: [] };
  clientsState = {
    activeClientId: 'acme',
    clients: [
      { id: 'acme', displayName: 'Acme Retail', status: 'active', accent: '#22566d', timezone: 'UTC', rev: 'abc123abc123', schedulerRunning: true, actionBlocked: true },
      { id: 'globex', displayName: 'Globex Inc', status: 'active', accent: '#0ea5e9', timezone: 'UTC', rev: 'def456def456', schedulerRunning: true, actionBlocked: false },
    ],
  };
});

async function openEditForm(user, name) {
  await user.click(screen.getByRole('button', { name: new RegExp(`edit ${name}`, 'i') }));
  return screen.findByRole('form', { name: /edit project/i });
}

function makeImage(name = 'logo.png', type = 'image/png') {
  return new File([new Uint8Array([1, 2, 3])], name, { type });
}

describe('Clients table Health cell (B5)', () => {
  it('renders a Health column header', () => {
    renderClients();
    expect(screen.getByRole('columnheader', { name: /health/i })).toBeInTheDocument();
  });

  it('shows an action-blocked signal (accessible text) for the blocked client and an ok state for the clear one', () => {
    renderClients();
    const acmeRow = screen.getByRole('row', { name: /acme retail/i });
    expect(within(acmeRow).getByText(/action blocked/i)).toBeInTheDocument();

    const globexRow = screen.getByRole('row', { name: /globex inc/i });
    expect(within(globexRow).queryByText(/action blocked/i)).not.toBeInTheDocument();
    expect(within(globexRow).getByText(/\bok\b/i)).toBeInTheDocument();
  });

  // D13 (phase 3, LOAD cut): nothing in scheduling reads a project's timezone at a glance, so
  // the table drops the column; the field stays in the edit form.
  it('has no Timezone column and no timezone value in the rows', () => {
    renderClients();
    expect(screen.queryByRole('columnheader', { name: /timezone/i })).toBeNull();
    const acmeRow = screen.getByRole('row', { name: /acme retail/i });
    expect(within(acmeRow).queryByText('UTC')).toBeNull();
  });

  it('has no axe violations', async () => {
    const { container } = renderClients();
    expect(await axeClean(container)).toHaveNoViolations();
  });
});

// Tier-3 (phase 3): the page title "Projekte" is the app chrome's own <h1> (App.jsx pageTitle),
// so the page no longer repeats it as a parenthetical h2 ("Projekte (lokale Arbeitsbereiche)").
describe('Clients page does not repeat its title', () => {
  it('renders no in-page heading that repeats the page title', () => {
    renderClients();
    expect(screen.queryByRole('heading', { level: 2, name: /projects/i })).toBeNull();
    expect(screen.queryByText(/\(local workspaces\)/i)).toBeNull();
  });
});

describe('Clients subtitle is sentence case (US-MC-13 anti-slop)', () => {
  it('renders the subtitle without an all-caps shouted "LOCAL" token', () => {
    renderClients();
    // clients.subtitle must read in sentence case ("Local client administration"),
    // never the all-caps-for-emphasis "LOCAL ..." that violates the DESIGN.md rule.
    // One sentence (Q9): what a project is, where it lives, what it does not need.
    const subtitle = screen.getByText('Each project is its own workspace on this device, with no login and no billing.');
    expect(subtitle).toBeInTheDocument();
    expect(subtitle.textContent).not.toMatch(/\bLOCAL\b/);
  });
});

describe('Clients C5 ifRev concurrency + hardened logo upload', () => {
  it('echoes the read rev to updateClient on save', async () => {
    const user = userEvent.setup();
    renderClients();
    await openEditForm(user, 'Acme Retail');
    await user.click(screen.getByRole('button', { name: /save changes/i }));
    await waitFor(() => expect(updateClient).toHaveBeenCalledTimes(1));
    expect(updateClient).toHaveBeenCalledWith('acme', expect.objectContaining({ ifRev: 'abc123abc123' }));
  });

  it('uploads a picked logo via uploadAssetFile and sends a {path,url} logo (never {file})', async () => {
    const user = userEvent.setup();
    renderClients();
    await openEditForm(user, 'Acme Retail');
    const input = screen.getByLabelText(/logo/i);
    await user.upload(input, makeImage());
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => expect(uploadAssetFile).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(updateClient).toHaveBeenCalledTimes(1));
    const [, body] = updateClient.mock.calls[0];
    expect(body.logo).toEqual({ path: 'logo.png', url: '/media/logo.png' });
    expect(body.logo).not.toHaveProperty('file');
  });

  it('surfaces an inline banner when the server rejects the logo upload and does not submit', async () => {
    uploadAssetFile.mockRejectedValueOnce(Object.assign(new Error('a file named logo.png already exists in data/media'), { code: 'invalid_input' }));
    const user = userEvent.setup();
    renderClients();
    await openEditForm(user, 'Acme Retail');
    const input = screen.getByLabelText(/logo/i);
    await user.upload(input, makeImage()); // a valid .png; the SERVER rejects (duplicate)

    // One plain sentence inline; the server's English line rides the "?" only.
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Could not upload the logo.');
    expect(alert).not.toHaveTextContent(/already exists/i);
    expect(screen.getByRole('button', { name: /more about this/i })).toHaveAccessibleDescription(/already exists in data\/media/i);
    expect(updateClient).not.toHaveBeenCalled();
  });

  it('client-side rejects a non-image logo before any upload', async () => {
    const user = userEvent.setup();
    renderClients();
    await openEditForm(user, 'Acme Retail');
    const input = screen.getByLabelText(/logo/i);
    await user.upload(input, makeImage('clip.mp4', 'video/mp4'));

    expect(await screen.findByText(/png or jpg/i)).toBeInTheDocument();
    expect(uploadAssetFile).not.toHaveBeenCalled();
  });

  it('the edit form has no axe violations', async () => {
    const user = userEvent.setup();
    const { container } = renderClients();
    await openEditForm(user, 'Acme Retail');
    expect(await axeClean(container)).toHaveNoViolations();
  });
});

describe('Clients make-active (R2: shared invalidation + SR announcement)', () => {
  it('routes make-active through useSetActiveClient (one CLIENT_SCOPED_KEYS source of truth)', async () => {
    const user = userEvent.setup();
    renderClients();
    // globex is active=false, status=active, so its row shows the make-active control.
    const globexRow = screen.getByRole('row', { name: /globex inc/i });
    // The make-active button carries an explicit aria-label (clients.action.makeActive,
    // "Make {name} active"); pre-merge t() returns the raw key, so match a pattern
    // robust to both the raw key id and the merged copy rather than the bare text.
    await user.click(within(globexRow).getByRole('button', { name: /make.*active/i }));
    await waitFor(() => expect(setActive).toHaveBeenCalledWith('globex'));
  });

  it('announces the activated client to screen-reader users via a polite status region', async () => {
    const user = userEvent.setup();
    renderClients();
    const status = screen.getByRole('status');
    expect(status).toHaveAttribute('aria-live', 'polite');
    expect(status).toHaveTextContent(''); // silent until a switch happens
    const globexRow = screen.getByRole('row', { name: /globex inc/i });
    // The make-active button carries an explicit aria-label (clients.action.makeActive,
    // "Make {name} active"); pre-merge t() returns the raw key, so match a pattern
    // robust to both the raw key id and the merged copy rather than the bare text.
    await user.click(within(globexRow).getByRole('button', { name: /make.*active/i }));
    // The orchestrator merges clients.announce.activated centrally; pre-merge t()
    // returns the raw key, so assert the region becomes non-empty after a switch
    // rather than binding to the (not-yet-merged) translated copy.
    await waitFor(() => expect(status.textContent.length).toBeGreaterThan(0));
  });
});

// A4 archive safety: the confirm must be HONEST about a client's in-flight work
// and, when the platform itself already holds scheduled objects, must archive
// THROUGH the server's unschedule sweep rather than hiding a still-publishing
// brand. The overview roll-up (overviewState) carries the per-row inFlight
// counts; the engine half already returns them and gates on needs_confirm.
describe('Clients A4 archive-safety confirm', () => {
  it('idle client: plain archive dialog (suppressible), no unschedule sweep', async () => {
    // Default overviewState = { clients: [] } -> globex carries no in-flight row.
    const user = userEvent.setup();
    renderClients();
    const globexRow = screen.getByRole('row', { name: /globex inc/i });
    await user.click(within(globexRow).getByRole('button', { name: /archive globex/i }));
    const dialog = await screen.findByRole('dialog');
    // The idle-archive dialog keeps its "don't show again" suppression checkbox.
    expect(within(dialog).getByRole('checkbox')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: /^archive$/i }));
    await waitFor(() => expect(archiveClient).toHaveBeenCalledTimes(1));
    // No sweep: idle archive is unchanged (empty opts, no unscheduleInFlight).
    expect(archiveClient).toHaveBeenCalledWith('globex', {});
  });

  it('locally-fired in-flight: shows the count, drops the suppression, and parks via the sweep', async () => {
    overviewState = { clients: [{ id: 'globex', inFlight: { total: 3, local: 3, native: 0 } }] };
    const user = userEvent.setup();
    renderClients();
    const globexRow = screen.getByRole('row', { name: /globex inc/i });
    await user.click(within(globexRow).getByRole('button', { name: /archive globex/i }));
    const dialog = await screen.findByRole('dialog');
    // The count is SHOWN, not hidden behind a generic "archive?" copy.
    expect(within(dialog).getByText(/3 approved post/i)).toBeInTheDocument();
    // In-flight work must be SEEN: the suppression checkbox is gone.
    expect(within(dialog).queryByRole('checkbox')).not.toBeInTheDocument();
    // Confirming runs the sweep so nothing sits as invisible overdue backlog.
    await user.click(within(dialog).getByRole('button', { name: /unschedule and archive/i }));
    await waitFor(() => expect(archiveClient).toHaveBeenCalledTimes(1));
    expect(archiveClient).toHaveBeenCalledWith('globex', { unscheduleInFlight: true });
  });

  it('natively-scheduled in-flight: surfaces total + native counts and archives through the unschedule sweep', async () => {
    overviewState = { clients: [{ id: 'globex', inFlight: { total: 4, local: 2, native: 2 } }] };
    const user = userEvent.setup();
    renderClients();
    const globexRow = screen.getByRole('row', { name: /globex inc/i });
    await user.click(within(globexRow).getByRole('button', { name: /archive globex/i }));
    const dialog = await screen.findByRole('dialog');
    // Both the total on the way and the platform-scheduled subset are named.
    expect(within(dialog).getByText(/4 post\(s\) on the way/i)).toBeInTheDocument();
    expect(within(dialog).getByText(/2 of them scheduled on the platform/i)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: /unschedule and archive/i }));
    await waitFor(() => expect(archiveClient).toHaveBeenCalledTimes(1));
    expect(archiveClient).toHaveBeenCalledWith('globex', { unscheduleInFlight: true });
  });

  it('cancelling the in-flight archive never calls the server', async () => {
    overviewState = { clients: [{ id: 'globex', inFlight: { total: 2, local: 0, native: 2 } }] };
    const user = userEvent.setup();
    renderClients();
    const globexRow = screen.getByRole('row', { name: /globex inc/i });
    await user.click(within(globexRow).getByRole('button', { name: /archive globex/i }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: /cancel/i }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(archiveClient).not.toHaveBeenCalled();
  });

  it('server fails closed: a stale idle dialog re-asks with the server counts, then archives with the sweep', async () => {
    // Overview shows globex idle, so the first dialog is the plain archive; the
    // server then refuses (needs_confirm) with fresh native-scheduled counts.
    archiveClient.mockRejectedValueOnce(
      Object.assign(new Error('client globex still has in-flight work'), {
        code: 'needs_confirm',
        inFlight: { total: 2, local: 0, native: 2 },
      }),
    );
    const user = userEvent.setup();
    renderClients();
    const globexRow = screen.getByRole('row', { name: /globex inc/i });
    await user.click(within(globexRow).getByRole('button', { name: /archive globex/i }));
    const first = await screen.findByRole('dialog');
    await user.click(within(first).getByRole('button', { name: /^archive$/i }));
    // First (blind) attempt carried no sweep and was refused.
    await waitFor(() => expect(archiveClient).toHaveBeenNthCalledWith(1, 'globex', {}));
    // The re-ask shows the SERVER'S numbers and offers the sweep.
    const second = await screen.findByText(/2 of them scheduled on the platform/i);
    const reask = second.closest('[role="dialog"]');
    await user.click(within(reask).getByRole('button', { name: /unschedule and archive/i }));
    await waitFor(() => expect(archiveClient).toHaveBeenNthCalledWith(2, 'globex', { unscheduleInFlight: true }));
  });
});

describe('Clients archived ordering', () => {
  it('sorts archived projects below active ones regardless of source order', () => {
    clientsState = {
      activeClientId: 'acme',
      clients: [
        { id: 'zed', displayName: 'Zed Archived', status: 'archived', timezone: 'UTC', rev: 'r1' },
        { id: 'acme', displayName: 'Acme Retail', status: 'active', timezone: 'UTC', rev: 'r2' },
      ],
    };
    renderClients();
    const bodyRows = screen.getAllByRole('row').slice(1).map((r) => r.textContent);
    const acmeIdx = bodyRows.findIndex((tx) => /Acme Retail/.test(tx));
    const zedIdx = bodyRows.findIndex((tx) => /Zed Archived/.test(tx));
    expect(acmeIdx).toBeGreaterThanOrEqual(0);
    expect(zedIdx).toBeGreaterThan(acmeIdx);
    // The archived project keeps a usable restore action.
    expect(screen.getByRole('button', { name: /restore .*Zed Archived/i })).toBeInTheDocument();
  });
});

// final-a7: at 375px the overview table scrolled sideways (601px of table in a 309px box). Below
// md each project now reflows into a stacked row (the SAME table and cells, re-laid by CSS, so
// there is no second markup to drift): name and actions on top, status and timezone under it,
// the health line last. The column headers stay for assistive tech (sr-only), the desktop table
// is untouched, and nothing scrolls sideways on a phone. The real geometry (no sideways scroll
// at 375) is measured in verify-shell-scroll.cjs.
describe('Clients overview on a phone: stacked rows, no sideways scroll', () => {
  const tok = (el, t) => (el.getAttribute('class') || '').split(/\s+/).includes(t);

  it('the table is no sideways scroller below md and keeps its desktop scroller from md up', () => {
    renderClients();
    const table = screen.getByRole('table');
    for (let el = table.parentElement; el && !tok(el, 'rounded-2xl'); el = el.parentElement) {
      expect(tok(el, 'overflow-x-auto'), el.className).toBe(false);
    }
    expect(tok(table.parentElement, 'md:overflow-x-auto')).toBe(true);
    expect(tok(table, 'max-md:block')).toBe(true);
    expect(tok(table.querySelector('thead'), 'max-md:sr-only')).toBe(true);
    expect(tok(table.querySelector('tbody'), 'max-md:block')).toBe(true);
  });

  it('each project row is a two-column stacked grid: name and actions share the top line', () => {
    renderClients();
    const row = screen.getByRole('row', { name: /acme retail/i });
    for (const t of ['max-md:grid', 'max-md:grid-cols-[minmax(0,1fr)_auto]']) expect(tok(row, t), t).toBe(true);
    const cells = within(row).getAllByRole('cell');
    // D13: four cells, no Timezone column.
    expect(cells).toHaveLength(4);
    const [name, status, health, actions] = cells;
    expect(tok(name, 'max-md:row-start-1')).toBe(true);
    expect(tok(actions, 'max-md:row-start-1')).toBe(true);
    expect(tok(actions, 'max-md:col-start-2')).toBe(true);
    expect(tok(status, 'max-md:col-start-1')).toBe(true);
    expect(tok(health, 'max-md:col-span-2')).toBe(true);
    for (const c of cells) expect(tok(c, 'max-md:block'), c.className).toBe(true);
  });

  it('an empty cell takes no line on a phone (archived health)', () => {
    clientsState = {
      activeClientId: 'acme',
      clients: [
        { id: 'acme', displayName: 'Acme Retail', status: 'active', timezone: '', rev: 'r2' },
        { id: 'zed', displayName: 'Zed Archived', status: 'archived', timezone: 'UTC', rev: 'r1' },
      ],
    };
    renderClients();
    const acme = within(screen.getByRole('row', { name: /acme retail/i })).getAllByRole('cell');
    expect(tok(acme[2], 'max-md:hidden')).toBe(false);
    const zed = within(screen.getByRole('row', { name: /zed archived/i })).getAllByRole('cell');
    expect(tok(zed[2], 'max-md:hidden')).toBe(true);
    expect(tok(zed[3], 'max-md:hidden')).toBe(false);
  });
});

// The raw-error sweep: every Projects failure the owner sees is one plain sentence; a server
// line never renders inline, it rides the house "?" beside the alert.
describe('Clients failures speak a plain sentence', () => {
  const moreAbout = () => screen.getByRole('button', { name: /more about this/i });

  it('a message-less save failure still shows the plain sentence', async () => {
    updateClient.mockRejectedValueOnce(new Error());
    const user = userEvent.setup();
    renderClients();
    const form = await openEditForm(user, 'Acme Retail');
    await user.click(within(form).getByRole('button', { name: /^save/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not save the project.');
  });

  it('a save rejected with an English server line keeps it behind the "?"', async () => {
    updateClient.mockRejectedValueOnce(new Error('HTTP 500 internal'));
    const user = userEvent.setup();
    renderClients();
    const form = await openEditForm(user, 'Acme Retail');
    await user.click(within(form).getByRole('button', { name: /^save/i }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Could not save the project.');
    expect(alert).not.toHaveTextContent(/HTTP 500/);
    expect(moreAbout()).toHaveAccessibleDescription('HTTP 500 internal');
  });

  it('a failed archive says the plain sentence, the server line rides the "?"', async () => {
    archiveClient.mockRejectedValueOnce(new Error('HTTP 500 internal'));
    const user = userEvent.setup();
    renderClients();
    const globexRow = screen.getByRole('row', { name: /globex inc/i });
    await user.click(within(globexRow).getByRole('button', { name: /archive globex/i }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: /^archive$/i }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Could not complete the action.');
    expect(alert).not.toHaveTextContent(/HTTP 500/);
    expect(moreAbout()).toHaveAccessibleDescription('HTTP 500 internal');
  });

  it('an unreadable registry names the plain cause, the parser line rides the "?"', () => {
    clientsState = { error: { message: 'Unexpected token } in JSON at position 42' }, clients: [] };
    renderClients();
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Project registry unreadable');
    expect(alert).toHaveTextContent('Could not read data/clients.json');
    expect(alert).not.toHaveTextContent(/Unexpected token/);
    expect(moreAbout()).toHaveAccessibleDescription('Unexpected token } in JSON at position 42');
  });
});
