import { render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { axeClean } from '../../test-utils/axe.js';
import Clients from '../Clients.jsx';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { ConfirmProvider } from '../ui/confirm.jsx';

// A5: the cross-client Overview was MERGED into the admin table so each client
// renders exactly once (identity + status + health + actions in one row). The rich
// health signals (pending/overdue/scheduler/Meta-368) now live in the table's
// Health cell, still as NON-COLOR signals (text label + count + icon, never color).
let clientsState;
let overviewState;
let plansByClient;

vi.mock('../../lib/api.js', () => ({
  // r5-b1: each project's plans, so the row counts with the sidebar's own predicate.
  usePlansAll: (clients) => (clients || []).map((c) => ({ data: plansByClient[c.id], isLoading: false })),
  useClients: () => ({ data: clientsState, isLoading: false, isError: false, error: null }),
  useClientsOverview: () => ({ data: overviewState, isLoading: false, isError: false, error: null }),
  createClient: vi.fn(() => Promise.resolve({ ok: true })),
  updateClient: vi.fn(() => Promise.resolve({ ok: true, rev: 'new000000000' })),
  archiveClient: vi.fn(() => Promise.resolve({ ok: true })),
  setActiveClient: vi.fn(() => Promise.resolve({ ok: true })),
  useSetActiveClient: () => vi.fn(() => Promise.resolve({ ok: true })),
  uploadAssetFile: vi.fn(() => Promise.resolve({ ok: true, file: 'logo.png' })),
  // Spec 48 R10: the active-client ReviewSection Clients renders. Inert stubs.
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

const LATE = '2026-06-01T10:00:00.000Z';
beforeEach(() => {
  plansByClient = {};
  clientsState = {
    activeClientId: 'acme',
    clients: [
      { id: 'acme', displayName: 'Acme Retail', status: 'active', accent: '#22566d', timezone: 'UTC', rev: 'abc123abc123', schedulerRunning: true, actionBlocked: false },
      { id: 'globex', displayName: 'Globex Inc', status: 'active', accent: '#0ea5e9', timezone: 'UTC', rev: 'def456def456', schedulerRunning: false, actionBlocked: true },
    ],
  };
  overviewState = {
    clients: [
      { id: 'acme', displayName: 'Acme Retail', status: 'active', ready: true, schedulerRunning: true, pending: 3, overdue: 1, metaBlocked: false, nextDue: '2026-06-20T10:00:00.000Z', error: null },
      { id: 'globex', displayName: 'Globex Inc', status: 'active', ready: false, schedulerRunning: false, pending: 1, overdue: 0, metaBlocked: true, nextDue: '2026-06-21T10:00:00.000Z', error: null },
    ],
  };
});

describe('Clients table health (merged overview)', () => {
  it('renders one table row per registry client with their display name', () => {
    renderClients();
    const table = screen.getByRole('table');
    expect(within(table).getByText('Acme Retail')).toBeInTheDocument();
    expect(within(table).getByText('Globex Inc')).toBeInTheDocument();
  });

  it('shows per-client pending counts in the Health cell', () => {
    renderClients();
    const table = screen.getByRole('table');
    expect(within(table).getByText(/3 pending/i)).toBeInTheDocument();
  });

  it('surfaces a NON-COLOR action-blocked signal in the table (text, not color alone)', () => {
    renderClients();
    const table = screen.getByRole('table');
    // globex is metaBlocked: an accessible text signal renders, not color alone.
    expect(within(table).getAllByText(/blocked/i).length).toBeGreaterThan(0);
  });

  it('surfaces a NON-COLOR paused-delivery signal in plain words (never the English "Scheduler")', () => {
    renderClients();
    const table = screen.getByRole('table');
    expect(within(table).getByText(/delivery paused/i)).toBeInTheDocument();
    expect(within(table).queryByText(/scheduler/i)).not.toBeInTheDocument();
  });

  it('has no axe violations', async () => {
    const { container } = renderClients();
    expect(await axeClean(container)).toHaveNoViolations();
  });
});

// r5-b1: the Projekte row spoke its own word ("12 überfällig") for the same posts the cards and
// the sidebar call "Wartet auf dich" or "Wird wiederholt". It now counts with the ONE attention
// predicate (attentionSummary) and says the sidebar's words; ids never show as monospace slugs;
// an empty time zone is empty, not a "-".
describe('Clients row speaks the app\'s words', () => {
  const needsYou = { id: 'n1', approval: 'approved', derivedState: 'publish-failed', scheduledAt: LATE, lastFailure: { terminal: true, recovery: 'reconnect', message: 'x' } };
  const late = { id: 'o1', approval: 'approved', derivedState: 'overdue', scheduledAt: LATE };
  const retrying = { id: 'r1', approval: 'approved', derivedState: 'publish-failed', scheduledAt: LATE, lastFailure: { terminal: false, message: 'x' } };

  it('a refusal only the operator can fix reads "Waiting on you: n", like the sidebar', () => {
    plansByClient = { acme: { campaigns: [{ id: 'c', active: true, posts: [needsYou, late] }] } };
    renderClients();
    const row = screen.getByRole('row', { name: /acme retail/i });
    expect(within(row).getByText('Waiting on you: 1')).toBeInTheDocument();
    expect(within(row).queryByText(/overdue/i)).not.toBeInTheDocument();
  });

  it('plain late posts read "Overdue: n"; a post pendpost is retrying is not counted', () => {
    plansByClient = {
      acme: { campaigns: [{ id: 'c', active: true, posts: [late, retrying] }] },
      globex: { campaigns: [{ id: 'c', active: true, posts: [retrying] }] },
    };
    renderClients();
    expect(within(screen.getByRole('row', { name: /acme retail/i })).getByText('Overdue: 1')).toBeInTheDocument();
    const globex = screen.getByRole('row', { name: /globex inc/i });
    expect(within(globex).queryByText(/overdue|waiting on you/i)).not.toBeInTheDocument();
  });

  it('internal campaigns stay out of the count, exactly as in the sidebar', () => {
    plansByClient = { acme: { campaigns: [{ id: 'v', active: true, internal: true, posts: [late] }] } };
    renderClients();
    expect(within(screen.getByRole('row', { name: /acme retail/i })).queryByText(/overdue/i)).not.toBeInTheDocument();
  });

  it('shows the project name, never the id as a monospace slug (the id stays a hover away)', () => {
    const { container } = renderClients();
    expect(container.querySelector('.font-mono')).toBeNull();
    const table = screen.getByRole('table');
    expect(within(table).queryByText('acme')).not.toBeInTheDocument();
    expect(within(table).getByText('Acme Retail').getAttribute('title')).toBe('acme');
  });

  it('an empty time zone leaves its cell empty, never a "-" placeholder', () => {
    clientsState.clients[0].timezone = '';
    renderClients();
    const cells = within(screen.getByRole('row', { name: /acme retail/i })).getAllByRole('cell');
    expect(cells[3].textContent).toBe('');
  });
});
