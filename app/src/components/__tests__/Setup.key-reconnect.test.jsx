import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Setup from '../Setup.jsx';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { ConfirmProvider } from '../ui/confirm.jsx';

// D5: one verb, "Reconnect", with the mechanics each lane needs. A STATIC-key lane (nostr,
// telegram, discord, mastodon, wordpress, ghost) replaces its key in place: "Reconnect" opens
// the existing Connect panel on the connected card, secrets blank, with no disconnect and no
// confirm (nothing is removed). An OAuth lane still has to disconnect to re-consent, so it
// keeps the disconnect ceremony behind its reconnect confirm.
let lanes;
let focusLane;
const disconnectPlatform = vi.fn(() => Promise.resolve({ ok: true }));
const connectPlatform = vi.fn(() => Promise.resolve({ ok: true, started: true, interactive: false }));
const connectStatus = vi.fn(() => Promise.resolve({ ok: true, state: 'running', detail: null, authUrl: null }));

vi.mock('../../lib/cloud.js', () => ({
  useCapabilities: () => ({ data: undefined }),
  useCloud: () => ({ data: undefined }),
  useCloudClients: () => ({ data: undefined }),
}));
vi.mock('../../lib/api.js', () => ({
  usePendpostHealth: () => ({ data: { ok: true, ready: false, setup: { ok: true, ready: false, summary: { connected: lanes.length, validated: 0, skipped: 0, incomplete: 0, total: lanes.length }, config: { locale: 'en' }, platforms: lanes } }, isLoading: false, isError: false }),
  useSignals: () => ({ data: undefined, isLoading: false }),
  usePlans: () => ({ data: undefined }),
  useConfig: () => ({ data: { ok: true, rev: 'r1', identifiers: {}, posting: { locale: 'en', platforms: {}, skippedPlatforms: [] }, secrets: {} }, isLoading: false }),
  useAccounts: () => ({ data: {} }),
  useActiveClient: () => ({ activeClient: { displayName: 'Acme' } }),
  useDiscover: () => ({ data: undefined, isLoading: true }),
  saveConfig: vi.fn(), recheckHealth: vi.fn(() => Promise.resolve({ ok: true })),
  connectPlatform: (...a) => connectPlatform(...a), connectStatus: (...a) => connectStatus(...a),
  setMetaLane: vi.fn(), refreshLinkedinToken: vi.fn(), refreshXToken: vi.fn(), disconnectPlatform: (...a) => disconnectPlatform(...a),
  mastodonUpdateProfile: vi.fn(), nostrUpdateProfile: vi.fn(), telegramUpdateProfile: vi.fn(), youtubeUpdateProfile: vi.fn(),
}));

function renderSetup() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <TooltipProvider>
        <ConfirmProvider>
          <Setup focus={focusLane} />
        </ConfirmProvider>
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

const connectedLane = (platform, label, detail) => ({
  platform, label, status: 'connected', mode: 'live', connected: true, skipped: false, missing: [],
  connectAction: `node scripts/${platform}-social.mjs auth`,
  validation: { state: 'failed', ok: false, detail, checkedAt: '2026-09-25T09:00:00Z', fix: null },
  playbook: { portalUrl: 'https://example.com', appToCreate: 'an app', productsToAdd: [], scopes: [], steps: [] },
});

beforeEach(() => {
  disconnectPlatform.mockClear();
  connectPlatform.mockClear();
  connectStatus.mockClear();
});

describe('Setup: key-based lanes reconnect in place (D5)', () => {
  it('a Nostr key-parse failure says the stored key is invalid; Reconnect opens the connect fields without disconnecting', async () => {
    lanes = [connectedLane('nostr', 'Nostr', 'NOSTR_PRIVATE_KEY must be nsec1... (bech32) or 64-char hex')];
    focusLane = 'nostr';
    const user = userEvent.setup();
    renderSetup();
    const card = within(screen.getByRole('region', { name: 'Nostr' }));
    expect(card.getByText('The stored key for Nostr is not valid. Reconnecting fixes it.')).toBeInTheDocument();
    // The raw engine text never renders inline.
    const visible = screen.getByRole('region', { name: 'Nostr' }).cloneNode(true);
    visible.querySelectorAll('.sr-only').forEach((n) => n.remove());
    expect(visible.textContent).not.toMatch(/NOSTR_PRIVATE_KEY|bech32/);
    // "Trennen" stays hidden while the reconnect is offered; the fix prompt stays secondary.
    expect(card.queryByRole('button', { name: 'Disconnect' })).toBeNull();
    expect(card.queryByLabelText('Private key')).toBeNull();

    await user.click(card.getByRole('button', { name: 'Reconnect' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(disconnectPlatform).not.toHaveBeenCalled();
    const key = card.getByLabelText('Private key');
    expect(key).toHaveValue('');
    expect(card.getByLabelText('Relays')).toHaveValue('');
    // One "Reconnect" button: the trigger yields to the panel's own submit.
    expect(card.getAllByRole('button', { name: 'Reconnect' })).toHaveLength(1);

    await user.type(key, 'nsec1qqqq');
    await user.click(card.getByRole('button', { name: 'Reconnect' }));
    await waitFor(() => expect(connectPlatform).toHaveBeenCalledWith('nostr', { privateKey: 'nsec1qqqq', relays: '', nwcUri: '' }));
    expect(disconnectPlatform).not.toHaveBeenCalled();
  });

  // Q3: the in-place reconnect's own failure. A typed nsec the engine cannot parse fails the
  // connect ceremony with the auth run's English stderr line; a blank key on a first connect
  // is a 400 "nostr needs privateKey". Both read as plain words; the raw text sits behind "?".
  it('a bad nsec typed into the reconnect says the key is not valid, never the engine text', async () => {
    lanes = [connectedLane('nostr', 'Nostr', 'NOSTR_PRIVATE_KEY must be nsec1... (bech32) or 64-char hex')];
    focusLane = 'nostr';
    const raw = '[err] NOSTR_PRIVATE_KEY must be nsec1... (bech32) or 64-char hex';
    connectStatus.mockResolvedValueOnce({ ok: true, state: 'failed', detail: raw, authUrl: null });
    const user = userEvent.setup();
    renderSetup();
    const region = screen.getByRole('region', { name: 'Nostr' });
    const card = within(region);
    await user.click(card.getByRole('button', { name: 'Reconnect' }));
    await user.type(card.getByLabelText('Private key'), 'nsec1bogus');
    await user.click(card.getByRole('button', { name: 'Reconnect' }));
    const alert = await card.findByRole('alert');
    expect(alert).toHaveTextContent('That key is not valid. Check it and try again.');
    expect(alert.textContent).not.toMatch(/NOSTR_PRIVATE_KEY|bech32|nsec1/);
    const visible = region.cloneNode(true);
    visible.querySelectorAll('.sr-only').forEach((n) => n.remove());
    expect(visible.textContent).not.toMatch(/NOSTR_PRIVATE_KEY/);
    // The raw line is one "?" away, not gone.
    expect(region.textContent).toContain(raw);
  });

  it('a 400 "nostr needs privateKey" names the missing field in the owner\'s words', async () => {
    lanes = [connectedLane('nostr', 'Nostr', 'no relay reachable (0/3)')];
    focusLane = 'nostr';
    connectPlatform.mockRejectedValueOnce(new Error('nostr needs privateKey'));
    const user = userEvent.setup();
    renderSetup();
    const card = within(screen.getByRole('region', { name: 'Nostr' }));
    await user.click(card.getByRole('button', { name: 'Reconnect' }));
    await user.type(card.getByLabelText('Relays'), 'wss://nos.lol');
    await user.click(card.getByRole('button', { name: 'Reconnect' }));
    const alert = await card.findByRole('alert');
    expect(alert).toHaveTextContent('Still missing: Private key');
    expect(alert.textContent).not.toMatch(/privateKey|needs/);
  });

  it('a Nostr probe with no reachable relay says so, and offers the same in-place reconnect', async () => {
    lanes = [connectedLane('nostr', 'Nostr', 'no relay reachable (0/3)')];
    focusLane = 'nostr';
    const user = userEvent.setup();
    renderSetup();
    const card = within(screen.getByRole('region', { name: 'Nostr' }));
    expect(card.getByText('No Nostr relay answered. The relays may be down, or the list is out of date. Reconnect to change the relays.')).toBeInTheDocument();
    expect(card.queryByText(/did not accept|refused/)).toBeNull();
    await user.click(card.getByRole('button', { name: 'Reconnect' }));
    expect(card.getByLabelText('Relays')).toBeInTheDocument();
    expect(disconnectPlatform).not.toHaveBeenCalled();
  });

  it('an expired Telegram token reconnects in place too: the token field starts blank', async () => {
    lanes = [connectedLane('telegram', 'Telegram', 'telegram: getMe: HTTP 401 - Unauthorized')];
    focusLane = 'telegram';
    const user = userEvent.setup();
    renderSetup();
    const card = within(screen.getByRole('region', { name: 'Telegram' }));
    await user.click(card.getByRole('button', { name: 'Reconnect' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(card.getByLabelText('Bot token')).toHaveValue('');
    expect(disconnectPlatform).not.toHaveBeenCalled();
  });

  it('an OAuth lane (LinkedIn, expired) still reconnects through the disconnect confirm', async () => {
    lanes = [connectedLane('linkedin', 'LinkedIn', 'token expired')];
    focusLane = 'linkedin';
    const user = userEvent.setup();
    renderSetup();
    const card = within(screen.getByRole('region', { name: 'LinkedIn' }));
    await user.click(card.getByRole('button', { name: 'Reconnect' }));
    const dialog = within(await screen.findByRole('dialog'));
    expect(dialog.getByText('Reconnect LinkedIn?')).toBeInTheDocument();
    await user.click(dialog.getByRole('button', { name: 'Reconnect' }));
    await waitFor(() => expect(disconnectPlatform).toHaveBeenCalledWith('linkedin'));
  });
});
