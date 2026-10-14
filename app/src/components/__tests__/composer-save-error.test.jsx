import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import userEvent from '@testing-library/user-event';
import Composer from '../Composer.jsx';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { ConfirmProvider } from '../ui/confirm.jsx';
import { I18nProvider } from '../../lib/i18n.js';

// A failed save speaks ONE plain sentence (humanizeAction), never the server's raw English
// line inline; the raw line rides the house "?" beside it. A stale write keeps its own
// sentence.
const updatePost = vi.fn();

vi.mock('../../lib/api.js', () => ({
  useActiveClient: () => ({ activeClient: null, activeClientId: null }),
  useAssets: () => ({ data: { dir: '/tmp/assets', assets: [] } }),
  useConfig: () => ({ data: { posting: { hashtagPresets: [] } } }),
  usePlatformValidate: () => ({ data: undefined }),
  useValidateMedia: () => ({ data: undefined }),
  useRedditFlairs: () => ({ data: undefined, isLoading: false }),
  usePinterestBoardSections: () => ({ data: undefined, isLoading: false }),
  createPost: vi.fn(() => Promise.resolve({ ok: true })),
  updatePost: (...a) => updatePost(...a),
  lintText: vi.fn(() => Promise.resolve({ ok: true, clean: true, findings: [] })),
}));

const post = {
  id: 'p1',
  campaign: 'launch',
  type: 'video',
  platforms: ['telegram'],
  approval: 'draft',
  derivedState: 'scheduled',
  scheduledAt: '2026-07-01T10:00:00Z',
  caption: 'a caption',
  rev: 1,
  media: { file: null, exists: false, url: null, cover: null, path: null },
};

function renderEdit(locale = 'en') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <I18nProvider locale={locale}>
        <TooltipProvider>
          <ConfirmProvider>
            <Composer mode="edit" post={post} campaigns={[{ id: 'launch', active: true, posts: [post] }]} onClose={vi.fn()} onSaved={vi.fn()} />
          </ConfirmProvider>
        </TooltipProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => { updatePost.mockReset(); });

describe('Composer save failures speak a plain sentence', () => {
  it('a message-less failure still says the plain sentence', async () => {
    updatePost.mockRejectedValue(new Error());
    const user = userEvent.setup();
    renderEdit();
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('That did not work. Please try again.');
  });

  it('an English server error is not inline; its raw line is the "?" description', async () => {
    updatePost.mockRejectedValue(new Error('HTTP 500 internal'));
    const user = userEvent.setup();
    renderEdit();
    await user.click(screen.getByRole('button', { name: 'Save' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('That did not work. Please try again.');
    expect(alert).not.toHaveTextContent(/HTTP 500/);
    expect(screen.getByRole('button', { name: /more about this/i })).toHaveAccessibleDescription('HTTP 500 internal');
  });

  it('a stale write keeps its own sentence', async () => {
    updatePost.mockRejectedValue(Object.assign(new Error('rev mismatch'), { code: 'stale_write' }));
    const user = userEvent.setup();
    renderEdit('de-CH');
    await user.click(screen.getByRole('button', { name: 'Speichern' }));
    const alert = await screen.findByRole('alert');
    expect(alert).not.toHaveTextContent(/rev mismatch/);
    expect(alert.textContent.length).toBeGreaterThan(10);
  });
});
