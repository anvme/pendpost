import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import PostDetail from '../PostDetail.jsx';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { ConfirmProvider } from '../ui/confirm.jsx';
import { I18nProvider } from '../../lib/i18n.js';

// The fail-closed backstop hold (lib/scheduler.mjs claim gate): the cloud already has
// this post and cannot answer the publish claim, so pendpost does not send it again until
// the cloud answers. A manual "Publish now" during the hold must say exactly that, never
// the cloud_held promise that "the local backstop steps in within 20 minutes" (critic
// finding 3), because here it deliberately does not.

const resumeLaneMock = vi.fn(() => Promise.resolve({ ok: true }));
const runPublishDueMock = vi.fn(() => Promise.resolve({ ran: [] }));

// A distinct portal URL proves the link is single-sourced from the health/setup
// payload (lib/playbooks.mjs -> setup.platforms[].playbook.portalUrl), not hardcoded.
const PAYLOAD_PORTAL = 'https://developer.x.com/en/portal/dashboard?from=payload';

vi.mock('../../lib/api.js', () => ({
  useInsights: () => ({ data: undefined }),
  useActiveClient: () => ({ activeClient: { id: 'acme', displayName: 'Acme Retail', accent: '#22566d' }, activeClientId: 'acme' }),
  usePendpostHealth: () => ({ data: { setup: { platforms: [{ platform: 'x', playbook: { portalUrl: PAYLOAD_PORTAL } }] } } }),
  useConfig: () => ({ data: null }),
  useAccounts: () => ({ data: { meta: { paused: false } } }),
  usePlatformValidate: () => ({ data: undefined }),
  useRedditFlairs: () => ({ data: undefined, isLoading: false }),
  usePresubmitCheck: () => ({ data: undefined }),
  useValidateMedia: () => ({ data: undefined }),
  useAssets: () => ({ data: { dir: 'data/media', assets: [] } }),
  approvePost: vi.fn(),
  rejectPost: vi.fn(),
  runPublishDue: (...a) => runPublishDueMock(...a),
  deletePost: vi.fn(() => Promise.resolve({ ok: true })),
  unschedulePost: vi.fn(),
  reschedulePost: vi.fn(() => Promise.resolve({ ok: true })),
  markPosted: vi.fn(),
  verifyPost: vi.fn(() => Promise.resolve({ ok: true })),
  setCoverFrame: vi.fn(),
  uploadCover: vi.fn(),
  clearCover: vi.fn(),
  updatePost: vi.fn(),
  editPublished: vi.fn(),
  discordScheduleEvent: vi.fn(),
  mastodonPin: vi.fn(),
  resumeLane: (...a) => resumeLaneMock(...a),
}));

const base = {
  id: 'p1',
  campaign: 'launch',
  caption: 'Hello world',
  platforms: ['x'],
  approval: 'approved',
  status: 'planned',
  scheduledAt: '2026-06-01T10:00:00Z',
  type: 'text',
  rev: 1,
  executionMode: 'fully-scheduled',
  image: null,
  ids: {},
  cover: null,
  publishedVia: null,
  externalUrl: null,
  verify: null,
  media: { file: null, exists: true, bytes: 10, url: null, cover: null, path: null },
};

function renderDetail(post, onClose = () => {}, onNavigate = undefined) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <I18nProvider locale="en">
        <TooltipProvider>
          <ConfirmProvider>
            <PostDetail post={post} onClose={onClose} onEdit={() => {}} onNavigate={onNavigate} />
          </ConfirmProvider>
        </TooltipProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );
}


// An overdue post with a transient failure, so the footer offers "Publish now".
const overduePost = {
  ...base,
  platforms: ['instagram'],
  derivedState: 'publish-failed',
  lastFailure: { lane: 'meta', at: '2026-06-01T10:03:00Z', message: 'temporary upstream hiccup', terminal: false, halted: false, haltCode: null },
};

beforeEach(() => {
  runPublishDueMock.mockClear();
  runPublishDueMock.mockResolvedValue({ ran: [] });
});

describe('publish-now during the fail-closed cloud hold', () => {
  it('says the cloud already has the post, never the 20-minute backstop promise', async () => {
    const user = userEvent.setup();
    runPublishDueMock.mockResolvedValueOnce({ ran: [
      { campaign: 'launch', postId: 'p1', lane: 'meta', ok: false, errorCode: 'cloud_claim_wait', errorMessage: 'the cloud already has this post' },
    ] });
    renderDetail(overduePost);
    await user.click(screen.getByRole('button', { name: /publish this overdue post now/i }));
    await user.click(await screen.findByRole('button', { name: /^publish now$/i }));
    expect(await screen.findByText(/won't publish it from here until the cloud answers/i)).toBeInTheDocument();
    expect(screen.queryByText(/20 minutes/i)).not.toBeInTheDocument();
  });
});

// A hold that outlasted 2 h (lib/plans.mjs CLOUD_CLAIM_WAIT_NEEDS_YOU_MS): the engine
// reports it as recovery 'cloud' (critic finding 4). The post waits on the owner, the
// banner says what to check and offers the cloud page, and publish-now is not offered
// (it would only hold again).
const longHeldPost = {
  ...base,
  platforms: ['instagram'],
  derivedState: 'publish-failed',
  lastFailure: { lane: 'meta', at: '2026-06-01T10:03:00Z', code: 'cloud_unanswered', message: 'the cloud already has this post and has not answered the publish claim for over 2 hours', terminal: true, recovery: 'cloud', halted: false, haltCode: null },
};

describe('a long fail-closed hold waits on the owner', () => {
  it('says the cloud has the post and offers the cloud page, never publish-now', async () => {
    const user = userEvent.setup();
    const onNavigate = vi.fn();
    renderDetail(longHeldPost, () => {}, onNavigate);
    expect(screen.getByText(/the cloud already has this post and hasn't answered for over 2 hours/i)).toBeInTheDocument();
    expect(screen.getByText(/waiting on you: pendpost won't publish it from here/i)).toBeInTheDocument();
    expect(screen.getByText('Waiting for the cloud')).toBeInTheDocument();
    expect(screen.queryByText(/did not accept/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /publish this overdue post now/i })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /open cloud service/i }));
    expect(onNavigate).toHaveBeenCalledWith('cloud');
  });
});
