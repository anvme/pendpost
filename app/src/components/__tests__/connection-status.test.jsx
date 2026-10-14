import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import ConnectionStatus from '../ConnectionStatus.jsx';
import { I18nProvider } from '../../lib/i18n.js';
import { TooltipProvider } from '../ui/Tooltip.jsx';

// ConnectionStatus replaces the dismissible SchedulerChip with a persistent, merged
// delivery + always-on control. We mock the cloud bridge so each merged state renders
// without the network: useCloud's value + the `running` prop pick the status line and
// icon, and the click-popover carries the two CTAs (external plans link + the in-app
// set-up/manage action). The status string also seeds the hover tooltip, so status
// assertions use getAllByText (the popover copy is the one that always renders).
let cloudState;
let subState;
let clientsState;
let capsState;
vi.mock('../../lib/cloud.js', () => ({
  useCloud: () => cloudState,
  useCloudClients: () => clientsState,
  useCloudSubscription: () => subState,
  useCapabilities: () => capsState,
}));

function renderStatus(props) {
  return render(
    <I18nProvider locale="en">
      <TooltipProvider>
        <ConnectionStatus {...props} />
      </TooltipProvider>
    </I18nProvider>,
  );
}

const trigger = () => screen.getByRole('button', { name: 'Delivery and 24/7 status' });

beforeEach(() => {
  cloudState = { data: undefined, isLoading: true };
  subState = { data: undefined };
  clientsState = { data: { clients: [] } };
  capsState = { data: { cloudLanes: ['meta', 'linkedin', 'x'], nativeLanes: ['youtube', 'mastodon', 'wordpress', 'ghost'], localOnlyLanes: ['reddit', 'tiktok'] } };
});

describe('ConnectionStatus', () => {
  it('renders a persistent, non-dismissible trigger (no dismiss control)', () => {
    renderStatus({ running: true });
    expect(trigger()).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /dismiss|ausblenden/i })).not.toBeInTheDocument();
  });

  it('local running: popover names the keep-open status and the external plans link', async () => {
    const user = userEvent.setup();
    cloudState = { data: { workspaceId: '', enabled: false }, isLoading: false };
    renderStatus({ running: true });
    await user.click(trigger());
    expect(screen.getAllByText('Publishing while pendpost is open').length).toBeGreaterThan(0);
    const plans = await screen.findByRole('link', { name: /view plans and pricing/i });
    // Links at the live /services page; ?from=app flips its managed CTA to "enable always-on".
    expect(plans).toHaveAttribute('href', 'https://pendpost.com/services?from=app');
    expect(plans).toHaveAttribute('target', '_blank');
    expect(screen.getByRole('button', { name: 'Set up 24/7 service' })).toBeInTheDocument();
    // The disconnected upsell carries an inline price summary (less friction).
    expect(screen.getByText('Self-hosting: free forever.')).toBeInTheDocument();
    expect(screen.getByText(/plans include a pooled monthly post allowance/)).toBeInTheDocument();
  });

  it('cloud connected + keyed + enabled: shows the always-on status and a Manage cloud CTA', async () => {
    const user = userEvent.setup();
    // Operational = workspaceId AND the api key present AND the ACTIVE brand always-on
    // (the glyph follows the selected client, not the install).
    cloudState = { data: { workspaceId: 'ws_1', enabled: true, apiKey: { present: true } }, isLoading: false };
    clientsState = { data: { clients: [{ clientId: 'acme', active: true, alwaysOn: true }] } };
    renderStatus({ running: false });
    await user.click(trigger());
    expect(screen.getAllByText('Publishing around the clock through the cloud').length).toBeGreaterThan(0);
    expect(await screen.findByRole('button', { name: 'Manage cloud' })).toBeInTheDocument();
    // Connected: the inline price upsell is replaced by the live usage line, not shown.
    expect(screen.queryByText('Self-hosting: free forever.')).not.toBeInTheDocument();
  });

  it('cloud connected but KEYLESS (api key missing): not shown as cloud-on; falls back to local', async () => {
    // The keyless half-state: a workspace is connected but PENDPOST_CLOUD_API_KEY is absent,
    // so the cloud cannot publish - the same condition Cloud.jsx treats as "finish setup".
    // The header must NOT claim "publishing through the cloud"; the local scheduler is the
    // real firer, so it shows the local status instead (mirrors Cloud.jsx's connected gate:
    // workspaceId AND apiKey.present).
    const user = userEvent.setup();
    cloudState = { data: { workspaceId: 'ws_1', enabled: true, apiKey: { present: false } }, isLoading: false };
    renderStatus({ running: true });
    await user.click(trigger());
    expect(screen.queryByText('Publishing around the clock through the cloud')).not.toBeInTheDocument();
    expect(screen.getAllByText('Publishing while pendpost is open').length).toBeGreaterThan(0);
  });

  it('scheduler off, no cloud: shows the paused status', async () => {
    const user = userEvent.setup();
    cloudState = { data: { workspaceId: '', enabled: false }, isLoading: false };
    renderStatus({ running: false });
    await user.click(trigger());
    expect(screen.getAllByText('Paused until pendpost is open').length).toBeGreaterThan(0);
  });

  it('the set-up CTA routes to the in-app cloud page', async () => {
    const user = userEvent.setup();
    const onNavigate = vi.fn();
    cloudState = { data: { workspaceId: '', enabled: false }, isLoading: false };
    renderStatus({ running: true, onNavigate });
    await user.click(trigger());
    await user.click(await screen.findByRole('button', { name: 'Set up 24/7 service' }));
    expect(onNavigate).toHaveBeenCalledWith('cloud');
  });

  // Every red (broken) state names the planner as where the fix happens, so every red
  // state must offer the planner CTA - not only the ones that carry a missed-count.
  // manifest_error is the regression that motivated this: its counts are structurally
  // zero (the reason ladder puts overdue/failed first), so gating the CTA on a count
  // stranded the one red state whose copy says "fix it in the planner" with only a
  // "Manage cloud" button that routes to the wrong page.
  function cloudOnBroken(reason, counts = {}) {
    cloudState = { data: { workspaceId: 'ws_1', enabled: true, apiKey: { present: true }, sync: { state: 'red', reason, pendingCount: 0, overdueCount: 0, failedCount: 0, ...counts } }, isLoading: false };
    clientsState = { data: { clients: [{ clientId: 'acme', active: true, alwaysOn: true }] } };
  }

  it('red manifest_error (zero missed-count): still offers the planner CTA', async () => {
    const user = userEvent.setup();
    const onShowAtRisk = vi.fn();
    cloudOnBroken('manifest_error');
    renderStatus({ running: false, onShowAtRisk });
    await user.click(trigger());
    const cta = await screen.findByRole('button', { name: 'View in planner' });
    await user.click(cta);
    expect(onShowAtRisk).toHaveBeenCalledTimes(1);
  });

  // --- issues[]: the popover names each problem and offers exactly one fix ------------
  const now = new Date().toISOString();
  const issue = (over = {}) => ({ clientId: 'acme', clientName: 'Acme', campaign: 'c', postId: 'p1', title: 'Launch day', lane: 'linkedin', message: 'LinkedIn said: token expired', code: null, at: now, terminal: false, kind: 'post', ...over });
  function cloudOnIssues(issues, { state = 'red', clients = [{ clientId: 'acme', active: true, alwaysOn: true }] } = {}) {
    cloudState = { data: { workspaceId: 'ws_1', enabled: true, apiKey: { present: true }, sync: { state, reason: 'cloud_failures', pendingCount: 0, overdueCount: 0, failedCount: issues.length, issues } }, isLoading: false, refetch: vi.fn() };
    clientsState = { data: { clients } };
  }

  it('issues: a failed post shows its title, lane, a HUMANIZED reason (raw only as tooltip) and one "Open post" action', async () => {
    const user = userEvent.setup();
    const onIssueAction = vi.fn();
    const onShowAtRisk = vi.fn();
    cloudOnIssues([issue()]);
    renderStatus({ running: false, onIssueAction, onShowAtRisk });
    await user.click(trigger());
    expect(await screen.findByText('Launch day')).toBeInTheDocument();
    expect(screen.getByText(/LinkedIn ·/)).toBeInTheDocument();
    const why = screen.getByText(/LinkedIn no longer accepts the saved login/);
    expect(why).toHaveAttribute('title', 'LinkedIn said: token expired');
    expect(screen.queryByText('LinkedIn said: token expired')).not.toBeInTheDocument();
    expect(screen.queryByText('Cloud: 1 undelivered')).not.toBeInTheDocument();
    // Every issue has its own fix now, so the planner-filter button is gone.
    expect(screen.queryByRole('button', { name: 'View in planner' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Open post' }));
    expect(onIssueAction).toHaveBeenCalledWith(expect.objectContaining({ postId: 'p1' }), 'open');
    // Single project: no project name clutter.
    expect(screen.queryByText(/Acme ·/)).not.toBeInTheDocument();
  });

  it('issues: a credential refusal offers "Reconnect"; a terminal one says no more retries', async () => {
    const user = userEvent.setup();
    const onIssueAction = vi.fn();
    cloudOnIssues([issue({ kind: 'credential', code: 'account_unresolved', terminal: true })]);
    renderStatus({ running: false, onIssueAction });
    await user.click(trigger());
    // Names the platform, never "this platform".
    expect(await screen.findByText(/no connected LinkedIn account in this project/)).toBeInTheDocument();
    expect(screen.getByText('No more retries')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Reconnect' }));
    expect(onIssueAction).toHaveBeenCalledWith(expect.objectContaining({ kind: 'credential', lane: 'linkedin' }), 'reconnect');
  });

  it('issues: unreachable offers "Check again", which refetches the status', async () => {
    const user = userEvent.setup();
    cloudOnIssues([issue({ kind: 'unreachable', campaign: null, postId: null, title: null, lane: null, message: 'cloud request failed' })], { state: 'amber' });
    renderStatus({ running: false });
    await user.click(trigger());
    await user.click(await screen.findByRole('button', { name: 'Check again' }));
    expect(cloudState.refetch).toHaveBeenCalled();
  });

  it('issues: at most 3 rows, then an "n more" row that opens the Cloud page; project names show with >1 project', async () => {
    const user = userEvent.setup();
    const onNavigate = vi.fn();
    cloudOnIssues(
      [1, 2, 3, 4, 5].map((n) => issue({ postId: `p${n}`, title: `Post ${n}`, clientName: 'Globex', clientId: 'globex' })),
      { clients: [{ clientId: 'acme', active: true, alwaysOn: true }, { clientId: 'globex', active: false, alwaysOn: true }] },
    );
    renderStatus({ running: false, onNavigate });
    await user.click(trigger());
    expect(await screen.findByText('Post 3')).toBeInTheDocument();
    expect(screen.queryByText('Post 4')).not.toBeInTheDocument();
    expect(screen.getAllByText(/Globex · LinkedIn/).length).toBe(3);
    await user.click(screen.getByRole('button', { name: '2 more' }));
    expect(onNavigate).toHaveBeenCalledWith('cloud');
  });

  it('issues: a problem in ANOTHER always-on project still shows while the active one publishes locally', async () => {
    const user = userEvent.setup();
    cloudOnIssues([issue({ clientId: 'globex', clientName: 'Globex' })], { clients: [{ clientId: 'acme', active: true, alwaysOn: false }, { clientId: 'globex', active: false, alwaysOn: true }] });
    renderStatus({ running: true });
    await user.click(trigger());
    expect(await screen.findByText('Launch day')).toBeInTheDocument();
  });

  it('green: one "All delivered" line; sync null: no issue list', async () => {
    const user = userEvent.setup();
    cloudOnIssues([], { state: 'green' });
    const { unmount } = renderStatus({ running: false });
    await user.click(trigger());
    expect(await screen.findByText('All delivered')).toBeInTheDocument();
    unmount();
    cloudState = { data: { workspaceId: 'ws_1', enabled: true, apiKey: { present: true }, sync: null }, isLoading: false };
    renderStatus({ running: false });
    await user.click(trigger());
    expect(screen.queryByText('All delivered')).not.toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Cloud problems' })).not.toBeInTheDocument();
  });

  // A popover action that navigates must leave nothing floating over the next page.
  // Radix returns focus to the trigger when the popover closes, and the trigger is also
  // the status Tip's trigger: a focus-open tooltip then lingered over the page header
  // after "Manage cloud" (nothing blurs it, the pointer never leaves it). Every action
  // below closes the popover AND leaves no tooltip, while keyboard focus still shows it.
  it.each([
    ['Manage cloud', () => cloudOnIssues([], { state: 'green' })],
    ['2 more', () => cloudOnIssues([1, 2, 3, 4, 5].map((n) => issue({ postId: `p${n}`, title: `Post ${n}` })))],
    ['Open post', () => cloudOnIssues([issue()])],
    ['Reconnect', () => cloudOnIssues([issue({ kind: 'credential', code: 'account_unresolved' })])],
  ])('a popover action (%s) closes the popover and leaves no status tooltip behind', async (name, arrange) => {
    const user = userEvent.setup();
    const onNavigate = vi.fn();
    const onIssueAction = vi.fn();
    arrange();
    renderStatus({ running: false, onNavigate, onIssueAction });
    await user.click(trigger());
    await user.click(await screen.findByRole('button', { name }));
    expect(onNavigate.mock.calls.length + onIssueAction.mock.calls.length).toBe(1);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    // Focus goes back to the trigger (keyboard users keep their place)...
    expect(trigger()).toHaveFocus();
    // ...but a mouse action restoring focus must not pop the tooltip open.
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });

  it('keyboard focus on the trigger still shows the status tooltip', async () => {
    const user = userEvent.setup();
    cloudState = { data: { workspaceId: '', enabled: false }, isLoading: false };
    renderStatus({ running: true });
    await user.tab();
    expect(trigger()).toHaveFocus();
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Publishing while pendpost is open');
  });

  it('red cloud_failures (missed-count > 0): still offers the planner CTA', async () => {
    const user = userEvent.setup();
    const onShowAtRisk = vi.fn();
    cloudOnBroken('cloud_failures', { failedCount: 1 });
    renderStatus({ running: false, onShowAtRisk });
    await user.click(trigger());
    await user.click(await screen.findByRole('button', { name: 'View in planner' }));
    expect(onShowAtRisk).toHaveBeenCalledTimes(1);
  });
  // --- judge pass 2 ---------------------------------------------------------------------
  it('green: an all-clear popover spends no colour (no header dot) and drops the billing line + honesty paragraph', async () => {
    const user = userEvent.setup();
    cloudOnIssues([], { state: 'green' });
    subState = { data: { tier: 'studio', postsUsed: 12, postsIncluded: 300, checkoutEligible: false } };
    const { container } = renderStatus({ running: false });
    expect(trigger().querySelector('.rounded-full')).toBeNull();
    await user.click(trigger());
    expect(await screen.findByText('All delivered')).toBeInTheDocument();
    expect(screen.queryByText(/posts this month/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Honest limit/)).not.toBeInTheDocument();
    // One state line, no slogan title above it.
    expect(screen.queryByText('Stay online around the clock')).not.toBeInTheDocument();
    expect(container.ownerDocument.querySelector('.text-emerald-700')).toBeNull();
    // Manage cloud is the same quiet secondary in every state.
    expect(screen.getByRole('button', { name: 'Manage cloud' }).className).not.toMatch(/bg-brand/);
  });

  it('subscription read failed: the dot turns amber (same source as the Cloud page pill) with a one-line reason + Check again', async () => {
    const user = userEvent.setup();
    cloudOnIssues([], { state: 'green' });
    const refetchSub = vi.fn();
    subState = { data: undefined, isError: true, refetch: refetchSub };
    renderStatus({ running: false });
    expect(trigger().querySelector('.bg-amber-500')).not.toBeNull();
    await user.click(trigger());
    // r5: the title names the failed read of the plan info, not a limited cloud.
    expect(await screen.findByText('Subscription could not be loaded')).toBeInTheDocument();
    expect(screen.queryByText('Cloud delivery is limited')).not.toBeInTheDocument();
    expect(screen.getByText('Plan and billing show again once it loads. Delivery is not affected.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Check again' }));
    expect(refetchSub).toHaveBeenCalled();
    expect(cloudState.refetch).toHaveBeenCalled();
  });

  it('push pending (yellow): says why and offers Check again', async () => {
    const user = userEvent.setup();
    cloudOnIssues([], { state: 'yellow' });
    cloudState.data.sync.reason = 'push_pending';
    cloudState.data.sync.pendingCount = 2;
    renderStatus({ running: false });
    await user.click(trigger());
    expect(await screen.findByText(/The cloud confirms the approved posts shortly/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Check again' })).toBeInTheDocument();
  });

  // W1 (phase 3): waiting is not a warning. Only-waiting (yellow = push_pending) paints a
  // neutral grey dot, the same verdict the Cloud page pill reads; real warnings stay warm.
  it('push pending (yellow): the header dot is neutral grey, never amber', () => {
    cloudOnIssues([], { state: 'yellow' });
    cloudState.data.sync.reason = 'push_pending';
    cloudState.data.sync.pendingCount = 2;
    renderStatus({ running: false });
    expect(trigger().querySelector('.bg-zinc-400')).not.toBeNull();
    expect(trigger().querySelector('.bg-amber-500')).toBeNull();
    expect(trigger().querySelector('.bg-red-500')).toBeNull();
  });

  // A wait that outlived its grace (acks not landing while contact is fresh) is attention:
  // amber dot, its own sentence, and the existing Check again.
  it('push stuck (amber): amber dot, the plain sentence and Check again', async () => {
    const user = userEvent.setup();
    cloudOnIssues([], { state: 'amber' });
    cloudState.data.sync.reason = 'push_stuck';
    cloudState.data.sync.pendingCount = 1;
    renderStatus({ running: false });
    expect(trigger().querySelector('.bg-amber-500')).not.toBeNull();
    await user.click(trigger());
    expect(await screen.findByText('Cloud delivery is limited')).toBeInTheDocument();
    expect(screen.getByText('The cloud has not confirmed approved posts for over 10 minutes. Until it does, posts go out from this computer.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Check again' })).toBeInTheDocument();
  });

  // An on-flag drift heals itself (the next tick re-asserts the flag), so while it heals it
  // is a wait: grey dot, never the push counter ("Syncing 0 approved posts"), and a sentence
  // that says pendpost switches it back on.
  it('flag drift while healing (yellow): grey dot, no push counter, the plain sentence', async () => {
    const user = userEvent.setup();
    cloudOnIssues([], { state: 'yellow' });
    cloudState.data.sync.reason = 'flag_divergence';
    renderStatus({ running: false });
    expect(trigger().querySelector('.bg-zinc-400')).not.toBeNull();
    expect(trigger().querySelector('.bg-amber-500')).toBeNull();
    await user.click(trigger());
    expect(await screen.findByText('Cloud delivery is limited')).toBeInTheDocument();
    expect(screen.queryByText(/Syncing 0/)).not.toBeInTheDocument();
    expect(screen.getByText('The cloud lists this project as paused. pendpost switches it back on by itself. Until then, posts go out from this computer.')).toBeInTheDocument();
  });

  it('a real warning (amber worker_stale) keeps the amber dot; red keeps red', () => {
    cloudOnIssues([issue({ kind: 'worker_stale', campaign: null, postId: null, title: null, lane: null, message: 'x' })], { state: 'amber' });
    const { unmount } = renderStatus({ running: false });
    expect(trigger().querySelector('.bg-amber-500')).not.toBeNull();
    unmount();
    cloudOnBroken('cloud_failures', { failedCount: 1 });
    renderStatus({ running: false });
    expect(trigger().querySelector('.bg-red-500')).not.toBeNull();
  });

  it('push pending plus a failed subscription read stays amber (unknown is never fine)', () => {
    cloudOnIssues([], { state: 'yellow' });
    cloudState.data.sync.reason = 'push_pending';
    subState = { data: undefined, isError: true, refetch: vi.fn() };
    renderStatus({ running: false });
    expect(trigger().querySelector('.bg-amber-500')).not.toBeNull();
  });

  it('the state line counts problems and names the projects they span (why it can differ from the header overdue count)', async () => {
    const user = userEvent.setup();
    cloudOnIssues(
      [issue({ postId: 'a' }), issue({ postId: 'b', kind: 'credential', code: 'account_unresolved' }), issue({ postId: 'c', clientId: 'globex', clientName: 'Globex' })],
      { clients: [{ clientId: 'acme', active: true, alwaysOn: true }, { clientId: 'globex', active: false, alwaysOn: true }] },
    );
    renderStatus({ running: false });
    await user.click(trigger());
    expect(await screen.findByText('3 problems in 2 projects')).toBeInTheDocument();
  });

  it('the row action buttons carry a 44px hit area (TAP_TARGET) without a bigger painted box', async () => {
    const user = userEvent.setup();
    cloudOnIssues([issue()]);
    renderStatus({ running: false, onIssueAction: vi.fn() });
    await user.click(trigger());
    const btn = await screen.findByRole('button', { name: 'Open post' });
    expect(btn.className).toMatch(/after:h-11/);
    expect(btn.className).toMatch(/py-1\.5/);
  });

  it('connectivity: each kind says what is true (r5), "last reached HH:MM" instead of a relative time', async () => {
    const user = userEvent.setup();
    cloudOnIssues([issue({ kind: 'worker_stale', campaign: null, postId: null, title: null, lane: null, message: 'x' })], { state: 'amber' });
    const { unmount } = renderStatus({ running: false });
    await user.click(trigger());
    // r5: the stale worker has its own title; the cloud answers, it is not unreachable.
    expect(await screen.findByText('Cloud is not publishing right now')).toBeInTheDocument();
    expect(screen.queryByText('Cloud unreachable')).not.toBeInTheDocument();
    expect(screen.queryByText(/delivery service/)).not.toBeInTheDocument();
    unmount();
    cloudOnIssues([issue({ kind: 'unreachable', campaign: null, postId: null, title: null, lane: null, message: 'cloud request failed: fetch failed', lastOkAt: '2026-09-25T09:21:00.000Z' })], { state: 'amber' });
    renderStatus({ running: false });
    await user.click(trigger());
    expect(await screen.findByText(/^last reached /)).toBeInTheDocument();
    expect(screen.queryByText(/for a while/)).not.toBeInTheDocument();
  });

  // Final judge C7: the stale-worker row said nothing about "since when" while the
  // unreachable row did. It now carries the worker's last heartbeat the same way.
  it('worker_stale: shows "last active HH:MM" from the last worker heartbeat', async () => {
    const user = userEvent.setup();
    cloudOnIssues([issue({ kind: 'worker_stale', campaign: null, postId: null, title: null, lane: null, message: 'x', lastOkAt: '2026-09-25T09:21:00.000Z' })], { state: 'amber' });
    const { unmount } = renderStatus({ running: false });
    await user.click(trigger());
    // r5: the cloud answers, so "last reached" was wrong; the heartbeat is when it last worked.
    expect(await screen.findByText(/^last active /)).toBeInTheDocument();
    expect(screen.queryByText(/^last reached /)).not.toBeInTheDocument();
    unmount();
    // No heartbeat reported: no invented time.
    cloudOnIssues([issue({ kind: 'worker_stale', campaign: null, postId: null, title: null, lane: null, message: 'x' })], { state: 'amber' });
    renderStatus({ running: false });
    await user.click(trigger());
    await screen.findAllByText('Cloud is not publishing right now');
    expect(screen.queryByText(/^last (reached|active) /)).not.toBeInTheDocument();
  });
});
