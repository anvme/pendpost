import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import PostDetail from '../PostDetail.jsx';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { ConfirmProvider } from '../ui/confirm.jsx';
import { I18nProvider } from '../../lib/i18n.js';

// A failed action in the post detail leaves a lasting alert that is always a plain
// sentence (humanizeAction), never the server's raw English line inline. ActionButton
// hands over null for an error that carried no message, which used to leave no alert at
// all; a server message used to BE the alert. A sentence the Studio wrote itself (the
// "not live yet" read-back) is still the alert as-is.
const approvePostMock = vi.fn();
const verifyPostMock = vi.fn();
const unschedulePostMock = vi.fn();

vi.mock('../../lib/api.js', () => ({
  useInsights: () => ({ data: undefined }),
  useActiveClient: () => ({ activeClient: { id: 'acme', displayName: 'Acme Retail', accent: '#22566d' }, activeClientId: 'acme' }),
  usePendpostHealth: () => ({ data: { setup: { platforms: [] } } }),
  useConfig: () => ({ data: null }),
  useAccounts: () => ({ data: { meta: { paused: false } } }),
  usePlatformValidate: () => ({ data: undefined }),
  useRedditFlairs: () => ({ data: undefined, isLoading: false }),
  usePresubmitCheck: () => ({ data: undefined }),
  useValidateMedia: () => ({ data: undefined }),
  useAssets: () => ({ data: { dir: 'data/media', assets: [] } }),
  approvePost: (...a) => approvePostMock(...a),
  rejectPost: vi.fn(),
  runPublishDue: vi.fn(),
  deletePost: vi.fn(),
  unschedulePost: (...a) => unschedulePostMock(...a),
  reschedulePost: vi.fn(),
  markPosted: vi.fn(),
  verifyPost: (...a) => verifyPostMock(...a),
  setCoverFrame: vi.fn(),
  uploadCover: vi.fn(),
  clearCover: vi.fn(),
  updatePost: vi.fn(),
  editPublished: vi.fn(),
  discordScheduleEvent: vi.fn(),
  mastodonPin: vi.fn(),
}));

const basePost = {
  id: 'p1',
  campaign: 'launch',
  caption: 'Hello world',
  platforms: ['telegram'],
  approval: 'pending',
  derivedState: 'waiting-due',
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
  media: { file: null, exists: false, bytes: 0, url: null, cover: null, path: null },
};
// Handed off and past due: the footer's primary is Verify.
const firedPost = { ...basePost, id: 'p2', approval: 'approved', derivedState: 'fired-assumed', status: 'posted', ids: { tgMessageId: '42' } };

function renderDetail(post, locale = 'en') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <I18nProvider locale={locale}>
        <TooltipProvider>
          <ConfirmProvider>
            <PostDetail post={post} onClose={() => {}} onEdit={() => {}} />
          </ConfirmProvider>
        </TooltipProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  approvePostMock.mockReset();
  verifyPostMock.mockReset();
  unschedulePostMock.mockReset();
});

describe('PostDetail action errors speak a plain sentence', () => {
  it('a message-less approve failure still leaves the generic sentence as the alert', async () => {
    approvePostMock.mockRejectedValue(new Error());
    const user = userEvent.setup();
    renderDetail(basePost);
    await user.click(screen.getByRole('button', { name: /^approve$/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent('That did not work. Please try again.');
  });

  it('a server error is not shown inline; its raw line rides the "?" only', async () => {
    approvePostMock.mockRejectedValue(new Error('HTTP 500 internal'));
    const user = userEvent.setup();
    renderDetail(basePost);
    await user.click(screen.getByRole('button', { name: /^approve$/i }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('That did not work. Please try again.');
    expect(alert).not.toHaveTextContent(/HTTP 500/);
    expect(screen.getByRole('button', { name: /more about this/i })).toHaveAccessibleDescription('HTTP 500 internal');
  });

  it('the German surface says it in German', async () => {
    approvePostMock.mockRejectedValue(new Error('HTTP 500 internal'));
    const user = userEvent.setup();
    renderDetail(basePost, 'de-CH');
    await user.click(screen.getByRole('button', { name: /^freigeben$/i }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Das hat nicht geklappt. Bitte versuch es nochmals.');
    expect(alert).not.toHaveTextContent(/HTTP/);
  });

  it('a sentence the Studio wrote itself stays the alert (verify read back not live)', async () => {
    verifyPostMock.mockResolvedValue({ ok: true, liveCount: 0 });
    const user = userEvent.setup();
    renderDetail(firedPost);
    await user.click(screen.getByRole('button', { name: /actually live/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The post did not read back as live on any connected platform yet.');
  });

  // A native-object mutation asks first. The engine's needs_confirm line is English with
  // method-level detail ("parking it will delete the platform object(s) (...)"); the dialog
  // body is the Studio's own sentence, never that line.
  it('the park confirm says a plain sentence, never the engine line', async () => {
    unschedulePostMock.mockRejectedValueOnce(Object.assign(
      new Error('This post is natively scheduled on facebook - parking it will delete the platform object(s) (fb_1).'),
      { code: 'needs_confirm' },
    ));
    const user = userEvent.setup();
    renderDetail(basePost);
    await user.click(screen.getByRole('button', { name: /more actions/i }));
    await user.click(await screen.findByRole('button', { name: /^park$/i }));
    const dialog = await screen.findByRole('dialog', { name: /please confirm/i });
    expect(dialog).toHaveTextContent('This post is scheduled on the platform itself. Parking it deletes the scheduled copy there.');
    expect(dialog).not.toHaveTextContent(/fb_1|platform object/);
  });
});
