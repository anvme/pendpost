import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi } from 'vitest';
import PostDetail from '../PostDetail.jsx';
import { LinkCardPreview, ArticleCardPreview } from '../ui.jsx';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { ConfirmProvider } from '../ui/confirm.jsx';
import { I18nProvider } from '../../lib/i18n.js';

// Final judge finding 6: wasted space where there is nothing to show.
//  - A link / article card with no preview image painted a ~150px grey 1.91:1 box that
//    only said "no preview image". LinkedIn renders such a card as its title and domain
//    strip, so the preview does too: no hero at all when there is no image.
//  - The post detail of a Telegram text post that carries a link kept the two-column grid
//    with an EMPTY right column (~40% of the dialog): the layout asked "has a link" while
//    PostPreview asks "does this lane build a card" (only LinkedIn, or a blog lane). They
//    now ask the same question, so a text post whose preview renders nothing is one column.

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
  approvePost: vi.fn(), rejectPost: vi.fn(), deletePost: vi.fn(), unschedulePost: vi.fn(), reschedulePost: vi.fn(),
  markPosted: vi.fn(), verifyPost: vi.fn(), setCoverFrame: vi.fn(), uploadCover: vi.fn(), clearCover: vi.fn(),
}));

const wrap = (ui) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <I18nProvider locale="de-CH">
      <TooltipProvider>
        <ConfirmProvider>{ui}</ConfirmProvider>
      </TooltipProvider>
    </I18nProvider>
  </QueryClientProvider>
);

describe('link / article card without an image collapses to its text strip', () => {
  it('LinkCardPreview: no grey hero box, title and domain remain', () => {
    const { container } = render(wrap(<LinkCardPreview image={null} title="Why a human gate beats autopilot" link="https://example.com/blog/x" />));
    expect(screen.queryByText(/Kein Vorschaubild/)).not.toBeInTheDocument();
    expect(container.querySelector('[class*="aspect-[1.91/1]"]')).toBeNull();
    expect(screen.getByText('Why a human gate beats autopilot')).toBeInTheDocument();
    expect(screen.getByText('example.com')).toBeInTheDocument();
    expect(screen.getByText('LinkedIn-Kartenvorschau')).toBeInTheDocument();
  });

  it('LinkCardPreview WITH an image keeps the hero (the positive check is not blind)', () => {
    const { container } = render(wrap(<LinkCardPreview image="https://example.com/hero.jpg" title="T" link="https://example.com/x" />));
    expect(container.querySelector('img')).not.toBeNull();
  });

  it('ArticleCardPreview: no grey hero box, title remains', () => {
    const { container } = render(wrap(<ArticleCardPreview image={null} title="Blog title" excerpt="Short excerpt" />));
    expect(screen.queryByText(/Kein Hero-Bild/)).not.toBeInTheDocument();
    expect(container.querySelector('[class*="aspect-[1.91/1]"]')).toBeNull();
    expect(screen.getByText('Blog title')).toBeInTheDocument();
  });
});

const textPost = {
  id: 'tg-review', campaign: 'launch', title: '', caption: 'Planner tour for the Telegram channel, next steps inside.',
  platforms: ['telegram'], approval: 'pending', derivedState: 'draft', scheduledAt: '2099-07-01T10:00:00Z',
  type: 'text', rev: 1, executionMode: 'fully-scheduled', image: null, ids: {}, cover: null, publishedVia: null,
  externalUrl: null, verify: null, link: 'https://example.com/blog/planner-tour',
  media: { file: null, exists: false, bytes: null, url: null, cover: null, path: null },
};
const twoColumnGrid = () => document.querySelector('[class*="lg:grid-cols-[minmax(0,1.62fr)"]');

describe('post detail keeps a preview column only when the preview renders', () => {
  it('a Telegram text post with a link is one column (no empty right column)', () => {
    render(wrap(<PostDetail post={textPost} onClose={() => {}} onEdit={() => {}} />));
    expect(twoColumnGrid()).toBeNull();
  });

  it('a LinkedIn text post with a link keeps the two-column grid with its card', () => {
    render(wrap(<PostDetail post={{ ...textPost, id: 'li-article', platforms: ['linkedin'], title: 'Why a human gate' }} onClose={() => {}} onEdit={() => {}} />));
    expect(twoColumnGrid()).not.toBeNull();
    expect(screen.getByText('LinkedIn-Kartenvorschau')).toBeInTheDocument();
  });
});
