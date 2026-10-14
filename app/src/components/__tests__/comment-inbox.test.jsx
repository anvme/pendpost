import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import CommentInbox from '../radar/CommentInbox.jsx';
import { I18nProvider } from '../../lib/i18n.js';

// The Radar "On your posts" comment-inbox segment. These tests pin the ENABLE flow only
// (the button that was silently doing nothing): one click must (1) write
// commentWatch.enabled and (2) force the first sweep so results are visible at once, and a
// failed write must surface an inline error instead of a silent no-op. The populated /
// per-post thread paths are covered by comment-watch backend tests + CommentsPanel's suite.

// useConfig + the inbox result are mutable so a test can render the not-yet-loaded /
// off / populated states.
let configResult = { data: { rev: 'rev-1', posting: { commentWatch: { enabled: false } } } };
let inboxResult = { data: undefined, isLoading: false, refetch: vi.fn() };
const saveConfig = vi.fn(() => Promise.resolve({ ok: true }));
const refreshCommentInbox = vi.fn(() => Promise.resolve({ ok: true, posts: [] }));
const reactToPost = vi.fn(() => Promise.resolve({ ok: true }));
const resolveInboxComment = vi.fn(() => Promise.resolve({ ok: true }));

vi.mock('../../lib/api.js', () => ({
  useConfig: () => configResult,
  useCommentInbox: () => inboxResult,
  refreshCommentInbox: (...a) => refreshCommentInbox(...a),
  resolveInboxComment: (...a) => resolveInboxComment(...a),
  saveConfig: (...a) => saveConfig(...a),
  reactToPost: (...a) => reactToPost(...a),
  // CommentsPanel (rendered only when a row is expanded) imports these at module load.
  useComments: () => ({ data: undefined, isLoading: false }),
  replyToComment: vi.fn(), moderateComment: vi.fn(),
}));

const ENABLED = { data: { rev: 'rev-1', posting: { commentWatch: { enabled: true } } } };
const group = (over = {}) => ({
  campaign: 'c1', postId: 'p1', platform: 'mastodon', caption: 'my post',
  permalink: 'https://site/post', reactActions: ['favourite', 'boost'], unanswered: 1,
  lastCommentTs: '2026-08-09T10:00:00Z',
  comments: [{ key: 'x1', commentId: 'x1', lane: 'mastodon', author: 'someone@else', text: 'nice one', ts: '2026-08-09T10:00:00Z', permalink: 'https://else/comment/1' }],
  ...over,
});

function renderInbox() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <I18nProvider locale="en">
        <CommentInbox />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  saveConfig.mockClear();
  saveConfig.mockImplementation(() => Promise.resolve({ ok: true }));
  refreshCommentInbox.mockClear();
  reactToPost.mockClear();
  resolveInboxComment.mockClear();
  reactToPost.mockImplementation(() => Promise.resolve({ ok: true }));
  configResult = { data: { rev: 'rev-1', posting: { commentWatch: { enabled: false } } } };
  inboxResult = { data: undefined, isLoading: false, refetch: vi.fn() };
  // vitest shadows Node's experimental localStorage with a method-less stub; CommentInbox
  // reads/writes pendpost.comments.lastSeen on mount, so give it a real in-memory store.
  const store = {};
  vi.stubGlobal('localStorage', {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
  });
});

describe('CommentInbox enable flow', () => {
  it('one click writes commentWatch.enabled AND forces the first sweep', async () => {
    const user = userEvent.setup();
    renderInbox();
    await user.click(screen.getByRole('button', { name: 'Turn on monitoring' }));
    await waitFor(() => expect(saveConfig).toHaveBeenCalledWith('rev-1', { posting: { commentWatch: { enabled: true } } }));
    // The whole point of "one button": the sweep is forced immediately so results show up.
    await waitFor(() => expect(refreshCommentInbox).toHaveBeenCalledTimes(1));
  });

  it('a rejected write surfaces an inline error instead of a silent no-op', async () => {
    saveConfig.mockRejectedValueOnce(Object.assign(new Error('config changed since you read it - re-read and retry'), { code: 'stale_write' }));
    const user = userEvent.setup();
    renderInbox();
    await user.click(screen.getByRole('button', { name: 'Turn on monitoring' }));
    const alert = await screen.findByRole('alert');
    // One plain sentence; the server's English line rides the "?" only.
    expect(alert).toHaveTextContent('That did not go through. Try again.');
    expect(alert).not.toHaveTextContent(/config changed/);
    expect(screen.getByRole('button', { name: /more about this/i })).toHaveAccessibleDescription('config changed since you read it - re-read and retry');
    // A failed enable must not have forced a sweep.
    expect(refreshCommentInbox).not.toHaveBeenCalled();
  });

  it('a message-less enable failure still leaves the plain sentence as the alert', async () => {
    saveConfig.mockRejectedValueOnce(new Error());
    const user = userEvent.setup();
    renderInbox();
    await user.click(screen.getByRole('button', { name: 'Turn on monitoring' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('That did not go through. Try again.');
    expect(screen.queryByRole('button', { name: /more about this/i })).not.toBeInTheDocument();
  });

  it('the enable button is disabled until config has loaded (never clickable-but-inert)', async () => {
    configResult = { data: undefined };
    renderInbox();
    expect(screen.getByRole('button', { name: 'Turn on monitoring' })).toBeDisabled();
  });
});

describe('CommentInbox row: like + open-on-platform', () => {
  it('the author name links to the exact comment when the lane provides one', () => {
    configResult = ENABLED;
    inboxResult = { data: { posts: [group()], lastSweep: '2026-08-09T10:00:00Z' }, isLoading: false, refetch: vi.fn() };
    renderInbox();
    const link = screen.getByRole('link', { name: /someone@else/i });
    expect(link).toHaveAttribute('href', 'https://else/comment/1');
    expect(link).toHaveAttribute('target', '_blank');
  });

  it('the author name falls back to the post permalink when the comment has none (Instagram)', () => {
    configResult = ENABLED;
    inboxResult = { data: { posts: [group({ platform: 'instagram', reactActions: [], permalink: 'https://instagram.com/p/ABC',
      comments: [{ commentId: 'ig1', lane: 'meta', author: 'a_fan', text: 'love it', ts: '2026-08-09T10:00:00Z' }] })], lastSweep: 'x' }, isLoading: false, refetch: vi.fn() };
    renderInbox();
    expect(screen.getByRole('link', { name: /a_fan/i })).toHaveAttribute('href', 'https://instagram.com/p/ABC');
  });

  it('a supported lane shows a like that calls reactToPost with the lane verb, and reverts on reject', async () => {
    configResult = ENABLED;
    inboxResult = { data: { posts: [group()], lastSweep: 'x' }, isLoading: false, refetch: vi.fn() };
    const user = userEvent.setup();
    renderInbox();
    const like = screen.getByRole('button', { name: 'Like' });
    await user.click(like);
    await waitFor(() => expect(reactToPost).toHaveBeenCalledWith('c1', 'p1', 'x1', 'favourite', 'mastodon', undefined, false, 'someone@else', undefined));
    // pressed after a successful like
    await waitFor(() => expect(screen.getByRole('button', { name: 'Undo like' })).toBeInTheDocument());

    // a rejected like reverts the pressed state and surfaces an error
    reactToPost.mockRejectedValueOnce(new Error('HTTP 500 internal'));
    await user.click(screen.getByRole('button', { name: 'Undo like' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('That did not go through. Try again.');
    expect(alert).not.toHaveTextContent(/HTTP 500/);
    expect(screen.getByRole('button', { name: /more about this/i })).toHaveAccessibleDescription('HTTP 500 internal');
    expect(screen.getByRole('button', { name: 'Undo like' })).toBeInTheDocument();
  });

  // Owner-requested: "Mark handled" is ONE click - no confirm step in the way. A single tap
  // resolves every unanswered comment (scoped to the post) and the row leaves the view.
  it('Mark handled resolves in a single click, with no confirm step', async () => {
    configResult = ENABLED;
    inboxResult = { data: { posts: [group()], lastSweep: 'x' }, isLoading: false, refetch: vi.fn() };
    const user = userEvent.setup();
    renderInbox();
    await user.click(screen.getByRole('button', { name: 'Mark handled' }));
    // No confirm affordance appears; the resolve write fires straight away.
    expect(screen.queryByRole('button', { name: 'Dismiss' })).not.toBeInTheDocument();
    await waitFor(() => expect(resolveInboxComment).toHaveBeenCalledWith('x1', 'dismissed', undefined));
  });

  it('a failed Mark handled says the plain sentence; the raw server line rides the "?" only', async () => {
    configResult = ENABLED;
    inboxResult = { data: { posts: [group()], lastSweep: 'x' }, isLoading: false, refetch: vi.fn() };
    resolveInboxComment.mockRejectedValueOnce(new Error('HTTP 500 internal'));
    const user = userEvent.setup();
    renderInbox();
    await user.click(screen.getByRole('button', { name: 'Mark handled' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('That did not go through. Try again.');
    expect(alert).not.toHaveTextContent(/HTTP 500/);
    expect(screen.getByRole('button', { name: /more about this/i })).toHaveAccessibleDescription('HTTP 500 internal');
  });

  it('all projects: a failed Mark handled says the plain sentence, raw line behind the "?"', async () => {
    resolveInboxComment.mockRejectedValueOnce(new Error('HTTP 500 internal'));
    const user = userEvent.setup();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <I18nProvider locale="en">
          <CommentInbox allClients allPosts={[group({ clientId: 'acme', clientName: 'Acme' })]} />
        </I18nProvider>
      </QueryClientProvider>,
    );
    await user.click(screen.getByRole('button', { name: 'Mark handled' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('That did not go through. Try again.');
    expect(alert).not.toHaveTextContent(/HTTP 500/);
    expect(screen.getByRole('button', { name: /more about this/i })).toHaveAccessibleDescription('HTTP 500 internal');
  });

  // Non-happy path: a fast double-click must not dispatch the resolve twice. While the write is
  // in flight the button is disabled, so the second click is a no-op.
  it('Mark handled is guarded against double-fire while the resolve is in flight', async () => {
    configResult = ENABLED;
    inboxResult = { data: { posts: [group()], lastSweep: 'x' }, isLoading: false, refetch: vi.fn() };
    resolveInboxComment.mockReturnValueOnce(new Promise(() => {})); // never resolves -> stays in flight
    const user = userEvent.setup();
    renderInbox();
    const btn = screen.getByRole('button', { name: 'Mark handled' });
    await user.click(btn);
    expect(btn).toBeDisabled();
    await user.click(btn); // second click while in flight
    expect(resolveInboxComment).toHaveBeenCalledTimes(1);
  });

  it('an unsupported lane (Meta) shows no like control', () => {
    configResult = ENABLED;
    inboxResult = { data: { posts: [group({ platform: 'instagram', reactActions: [],
      comments: [{ commentId: 'ig1', lane: 'meta', author: 'a_fan', text: 'love it', ts: '2026-08-09T10:00:00Z', permalink: null }] })], lastSweep: 'x' }, isLoading: false, refetch: vi.fn() };
    renderInbox();
    expect(screen.queryByRole('button', { name: /^Like$/ })).not.toBeInTheDocument();
  });
});

// Raw-error sweep G3: the degrade row's and the unavailable-lane chip's "?" used Tip, which opens
// on hover or keyboard focus only, so a touch user could not read why. They are the shared InfoTip
// now: a tap pins the bubble, and the reason is the trigger's accessible description throughout.
describe('CommentInbox "?" reasons are reachable by tap', () => {
  const bubble = () => document.querySelector('[data-infotip-content]');
  it('a degraded lane row: the "?" is an InfoTip that a tap opens', async () => {
    configResult = ENABLED;
    inboxResult = { data: { posts: [], lastSweep: 'x', sources: { mastodon: { ok: false, error: 'needs_scope' } } }, isLoading: false, refetch: vi.fn() };
    renderInbox();
    const why = 'The Mastodon connection is not allowed to read comments right now. Reconnect the platform and grant the read permission.';
    const trigger = screen.getByRole('button', { name: /more about this/i });
    expect(trigger).toHaveAccessibleDescription(why);
    fireEvent.pointerEnter(trigger, { pointerType: 'touch' });
    fireEvent.click(trigger);
    await waitFor(() => expect(bubble()).toHaveTextContent(why));
  });

  it('an unavailable lane in settings: the "?" is an InfoTip that a tap opens', async () => {
    configResult = ENABLED;
    inboxResult = { data: { posts: [], lastSweep: 'x', capabilities: { linkedin: { readAvailable: false, readBlocked: 'linkedin_cma_pending' } } }, isLoading: false, refetch: vi.fn() };
    const user = userEvent.setup();
    renderInbox();
    await user.click(screen.getByRole('button', { name: 'Monitoring settings' }));
    const trigger = screen.getByRole('button', { name: /more about this/i });
    expect(trigger).toHaveAccessibleDescription(/does not let pendpost read comments yet/);
    fireEvent.click(trigger);
    await waitFor(() => expect(bubble()).toHaveTextContent(/does not let pendpost read comments yet/));
  });

  it('an unavailable lane with a reason code the locale does not know reads the generic sentence, never a raw key', async () => {
    configResult = ENABLED;
    inboxResult = { data: { posts: [], lastSweep: 'x', capabilities: { linkedin: { readAvailable: false, readBlocked: 'brand_new_code' } } }, isLoading: false, refetch: vi.fn() };
    const user = userEvent.setup();
    renderInbox();
    await user.click(screen.getByRole('button', { name: 'Monitoring settings' }));
    expect(screen.getByRole('button', { name: /more about this/i })).toHaveAccessibleDescription('This platform cannot read comments yet.');
  });
});
