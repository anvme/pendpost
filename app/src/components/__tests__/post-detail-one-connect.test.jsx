import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import PostDetail from '../PostDetail.jsx';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { ConfirmProvider } from '../ui/confirm.jsx';
import { I18nProvider } from '../../lib/i18n.js';

// Phase 3 D8: one verb for "not connected". A blocked post shows exactly ONE
// "{platform} verbinden" control. Before, the delivery row said "Blockiert: Telegram
// verbinden" as plain text AND either a wrench beside it or the Before-publishing card's
// "Telegram verbinden" link below it: the same words twice, or words plus an icon that
// did the job. Now:
//   - no setup link on the card -> the row's own words ARE the control (no wrench);
//   - the card offers its link  -> the row says only "Blockiert", the link is the control.
const setup = { platforms: [{ platform: 'telegram', status: 'incomplete' }] };
let validate;

vi.mock('../../lib/api.js', () => ({
  useInsights: () => ({ data: undefined }),
  useActiveClient: () => ({ activeClient: null, activeClientId: null }),
  usePendpostHealth: () => ({ data: { setup } }),
  useConfig: () => ({ data: null }),
  useAccounts: () => ({ data: { meta: { paused: false } } }),
  usePlatformValidate: () => ({ data: validate }),
  useRedditFlairs: () => ({ data: undefined, isLoading: false }),
  usePresubmitCheck: () => ({ data: undefined }),
  useValidateMedia: () => ({ data: undefined }),
  useAssets: () => ({ data: { dir: 'data/media', assets: [] } }),
  lintText: () => Promise.resolve({ ok: true, clean: true, errors: 0, warnings: 0, findings: [] }),
  approvePost: vi.fn(),
  rejectPost: vi.fn(),
  deletePost: vi.fn(),
  unschedulePost: vi.fn(),
  reschedulePost: vi.fn(),
  markPosted: vi.fn(),
  verifyPost: vi.fn(),
  setCoverFrame: vi.fn(),
  uploadCover: vi.fn(),
  clearCover: vi.fn(),
  runPublishDue: vi.fn(),
  updatePost: vi.fn(),
}));

const tgPost = {
  id: 'tg-future', campaign: 'launch', title: '', caption: 'Next week: a short tour of the planner.',
  platforms: ['telegram'], approval: 'approved', derivedState: 'waiting-due', type: 'text',
  scheduledAt: '2099-01-02T18:22:00.000Z', rev: 1, executionMode: 'fully-scheduled', image: null, ids: {}, media: { file: null, exists: false, items: [] },
};

function wrap(ui, locale = 'de-CH') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(['pendpost-health'], { setup });
  return render(
    <QueryClientProvider client={qc}>
      <I18nProvider locale={locale}>
        <TooltipProvider>
          <ConfirmProvider>{ui}</ConfirmProvider>
        </TooltipProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );
}

const connectControls = () => [...screen.queryAllByRole('button'), ...screen.queryAllByRole('link')]
  .filter((el) => /Telegram verbinden/.test(el.getAttribute('aria-label') || el.textContent));

beforeEach(() => { validate = undefined; });

describe('a blocked post has ONE "{platform} verbinden" control (D8)', () => {
  it('no setup link on the card: the row words are the one control, no wrench', async () => {
    const user = userEvent.setup();
    const onNavigate = vi.fn();
    wrap(<PostDetail post={tgPost} onClose={() => {}} onEdit={() => {}} onNavigate={onNavigate} />);
    const controls = connectControls();
    expect(controls).toHaveLength(1);
    expect(controls[0]).toHaveTextContent('Blockiert: Telegram verbinden');
    // The words appear once on the page, not as text plus a control.
    expect(screen.getAllByText(/Telegram verbinden/)).toHaveLength(1);
    // The wrench (its label was "Telegram verbinden, damit pendpost automatisch posten kann") is gone.
    expect(screen.queryByRole('button', { name: /damit pendpost automatisch posten kann/ })).not.toBeInTheDocument();
    await user.click(controls[0]);
    expect(onNavigate).toHaveBeenCalledWith('setup', 'telegram');
  });

  it('the card offers its setup link: the row says only "Blockiert", the link is the one control', async () => {
    const user = userEvent.setup();
    const onNavigate = vi.fn();
    validate = { ok: true, platforms: { telegram: { ready: false, needsSetup: true, problems: ['telegram: not connected'], warnings: [] } } };
    wrap(<PostDetail post={tgPost} onClose={() => {}} onEdit={() => {}} onNavigate={onNavigate} />);
    const controls = connectControls();
    expect(controls).toHaveLength(1);
    expect(controls[0]).toHaveTextContent(/^Telegram verbinden$/);
    expect(screen.getAllByText(/Telegram verbinden/)).toHaveLength(1);
    expect(screen.queryByText('Blockiert: Telegram verbinden')).not.toBeInTheDocument();
    await user.click(controls[0]);
    expect(onNavigate).toHaveBeenCalledWith('setup', 'telegram');
  });

  it('with nowhere to navigate, the row keeps its plain sentence and offers no control', () => {
    wrap(<PostDetail post={tgPost} onClose={() => {}} onEdit={() => {}} />);
    expect(connectControls()).toHaveLength(0);
    expect(screen.getByText('Blockiert: Telegram verbinden')).toBeInTheDocument();
  });
});
