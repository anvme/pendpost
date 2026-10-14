import { render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import PostDetail from '../PostDetail.jsx';
import { PostCard } from '../Planner.jsx';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { ConfirmProvider } from '../ui/confirm.jsx';
import { I18nProvider } from '../../lib/i18n.js';

// Phase 3 D1 + D2: red means "act now". failedDisplayKey (lib/format.js) is the one judge.
//   publish-retrying  -> pendpost heals it on its own: the banner and the planner card's
//                        reason line are neutral ink, no red or rose anywhere.
//   publish-needs-you -> only the banner frame and its title are red; the plain "why"
//                        line under it is neutral text (one red per banner).

let healthData;

vi.mock('../../lib/api.js', () => ({
  useInsights: () => ({ data: undefined }),
  useActiveClient: () => ({ activeClient: { id: 'acme', displayName: 'Acme Retail', accent: '#22566d' }, activeClientId: 'acme' }),
  usePendpostHealth: () => ({ data: healthData }),
  useConfig: () => ({ data: null }),
  useAccounts: () => ({ data: { meta: { paused: false } } }),
  usePlatformValidate: () => ({ data: undefined }),
  useRedditFlairs: () => ({ data: undefined, isLoading: false }),
  usePresubmitCheck: () => ({ data: undefined }),
  useValidateMedia: () => ({ data: undefined }),
  useAssets: () => ({ data: { dir: 'data/media', assets: [] } }),
  approvePost: vi.fn(),
  rejectPost: vi.fn(),
  runPublishDue: vi.fn(() => Promise.resolve({ ran: [] })),
  deletePost: vi.fn(() => Promise.resolve({ ok: true })),
  unschedulePost: vi.fn(),
  reschedulePost: vi.fn(() => Promise.resolve({ ok: true })),
  markPosted: vi.fn(() => Promise.resolve({ ok: true })),
  verifyPost: vi.fn(() => Promise.resolve({ ok: true })),
  setCoverFrame: vi.fn(),
  uploadCover: vi.fn(),
  clearCover: vi.fn(),
  updatePost: vi.fn(),
  editPublished: vi.fn(),
  discordScheduleEvent: vi.fn(),
  mastodonPin: vi.fn(),
  resumeLane: vi.fn(),
}));

const base = {
  id: 'p1',
  campaign: 'launch',
  caption: 'Fresh sourdough every Saturday.',
  platforms: ['linkedin'],
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
  derivedState: 'publish-failed',
  media: { file: null, exists: true, bytes: 10, url: null, cover: null, path: null },
};

const RAW_500 = 'linkedin: POST /rest/posts: HTTP 500 - LinkedIn returned an internal error, try again later.';
const retryingPost = {
  ...base,
  lastFailure: { lane: 'linkedin', at: '2026-06-01T10:03:00Z', message: RAW_500, terminal: false, halted: false, haltCode: null, code: null },
};

const NEEDS_SCOPE = 'LinkedIn POST /rest/posts: HTTP 403 ACCESS_DENIED - missing w_organization_social';
const needsYouPost = {
  ...base,
  id: 'p2',
  publishHold: { at: '2026-06-01T10:03:00Z', lane: 'linkedin', code: 'needs_scope', message: NEEDS_SCOPE },
  lastFailure: { lane: 'linkedin', at: '2026-06-01T10:03:00Z', code: 'needs_scope', message: NEEDS_SCOPE, terminal: true, recovery: 'reconnect', halted: false, haltCode: null },
};

const RED = /(?:^|\s)(?:dark:)?(?:hover:)?(?:text|bg|ring|border)-(?:red|rose)-/;
const isRed = (el) => RED.test(el.getAttribute('class') || '');
const redNodes = (root) => [root, ...root.querySelectorAll('*')].filter(isRed);
// A red TEXT element: an element whose own class paints its text red.
const redTextNodes = (root) => [root, ...root.querySelectorAll('*')].filter((el) => /(?:^|\s)text-(?:red|rose)-/.test(el.getAttribute('class') || ''));

function wrap(ui) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <I18nProvider locale="en">
        <TooltipProvider>
          <ConfirmProvider>{ui}</ConfirmProvider>
        </TooltipProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );
}

// The failure banner is the region that quotes the refusing lane.
function banner() {
  const title = screen.getByText(/did not accept this post/i);
  const el = title.closest('[role="alert"], [role="status"]');
  expect(el).toBeTruthy();
  return el;
}

beforeEach(() => {
  healthData = undefined;
});

describe('PostDetail failure banner tone (D1, D2)', () => {
  it('a retrying post: neutral banner, no red or rose anywhere in it, and it is not an alert', () => {
    wrap(<PostDetail post={retryingPost} onClose={() => {}} onEdit={() => {}} onNavigate={() => {}} />);
    const b = banner();
    expect(within(b).getByText(/tries again on its own/i)).toBeInTheDocument();
    expect(redNodes(b)).toEqual([]);
    // A self-healing state does not interrupt a screen reader either.
    expect(b.getAttribute('role')).toBe('status');
  });

  it('a needs-you post: the frame and title are red, the plain why line is neutral', () => {
    wrap(<PostDetail post={needsYouPost} onClose={() => {}} onEdit={() => {}} onNavigate={() => {}} />);
    const b = banner();
    expect(b.getAttribute('role')).toBe('alert');
    expect(isRed(b)).toBe(true);
    const reds = redTextNodes(b);
    expect(reds).toHaveLength(1);
    expect(reds[0].textContent).toMatch(/did not accept this post/i);
    const why = within(b).getByText(/linkedin needs a permission the connection does not have/i);
    expect(isRed(why)).toBe(false);
  });
});

describe('Planner card reason line tone (D1)', () => {
  // The reason line is the plain sentence, its hover title the same sentence (never the raw
  // platform line: that lives behind the post detail's "?").
  const reasonLine = () => [...document.querySelectorAll('p[title]')].find((el) => el.title === el.textContent);

  it('retrying: the reason line is neutral', () => {
    wrap(<PostCard post={retryingPost} onSelect={() => {}} />);
    const why = reasonLine();
    expect(why).toBeTruthy();
    expect(why.title).not.toBe(RAW_500);
    expect(isRed(why)).toBe(false);
  });

  it('needs you: the reason line stays red, the owner must act', () => {
    wrap(<PostCard post={needsYouPost} onSelect={() => {}} />);
    const why = reasonLine();
    expect(why).toBeTruthy();
    expect(why.title).not.toBe(NEEDS_SCOPE);
    expect(isRed(why)).toBe(true);
  });
});
