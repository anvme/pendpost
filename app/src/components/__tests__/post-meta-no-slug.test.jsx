import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi } from 'vitest';
import { ListView } from '../Planner.jsx';
import Freigaben from '../Freigaben.jsx';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { ConfirmProvider } from '../ui/confirm.jsx';
import { I18nProvider } from '../../lib/i18n.js';

// Final judge finding 4: the planner List row meta read "Launch · li-scope · Text" and the
// Freigaben card meta "Kampagne: Launch · tg-review". The post id is an infrastructure slug;
// the row's own headline already names the post (its title, else its first caption line),
// so the meta keeps only the human campaign label (plus the type on the List row). The raw
// campaign / post ids stay on the meta line's hover title for the operator who needs them,
// the same approach the post detail header took (e6922eba).

vi.mock('../../lib/api.js', () => ({
  usePlatformValidate: () => ({ data: null }),
  approvePost: vi.fn(() => Promise.resolve({ ok: true })),
  rejectPost: vi.fn(() => Promise.resolve({ ok: true })),
  markPosted: vi.fn(() => Promise.resolve({ ok: true })),
  lintText: vi.fn(() => Promise.resolve({ ok: true, clean: true, errors: 0, warnings: 0, findings: [] })),
  usePendpostHealth: () => ({ data: null }),
  useConfig: () => ({ data: null }),
  useAccounts: () => ({ data: null, isLoading: false, isError: false }),
  reschedulePost: vi.fn(),
}));

const NO_MEDIA = { file: null, exists: false, bytes: null, url: null, cover: null, path: null };
const liScope = {
  id: 'li-scope', campaign: 'launch', title: 'Launch week recap', caption: 'The approval gate now covers LinkedIn.',
  platforms: ['linkedin'], type: 'text', approval: 'pending', derivedState: 'draft',
  scheduledAt: '2099-07-01T10:00:00Z', image: null, media: NO_MEDIA,
};
const tgReview = {
  id: 'tg-review', campaign: 'launch', caption: 'Planner tour for the Telegram channel, next steps inside.',
  platforms: ['telegram'], type: 'text', approval: 'pending', derivedState: 'draft',
  scheduledAt: '2099-07-02T10:00:00Z', image: null, media: NO_MEDIA,
};

const wrap = (ui, locale = 'de-CH') => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <I18nProvider locale={locale}>
      <TooltipProvider>
        <ConfirmProvider>{ui}</ConfirmProvider>
      </TooltipProvider>
    </I18nProvider>
  </QueryClientProvider>
);

describe('Planner List row meta: campaign label, never the raw post slug', () => {
  it('reads "Launch · Text" with the raw ids only on the hover title', () => {
    const { container } = render(wrap(<ListView posts={[liScope, tgReview]} onSelect={() => {}} loading={false} lane={{}} />));
    expect(container.textContent).not.toContain('li-scope');
    expect(container.textContent).not.toContain('tg-review');
    const meta = screen.getAllByText('Launch · Text');
    expect(meta).toHaveLength(2);
    expect(meta[0]).toHaveAttribute('title', 'launch / li-scope');
    // The headline still names the post: its title, else its first caption line.
    expect(screen.getByText('Launch week recap')).toBeInTheDocument();
    expect(screen.getAllByText('Planner tour for the Telegram channel, next steps inside.').length).toBeGreaterThan(0);
  });
});

describe('Freigaben card meta: campaign label, never the raw post slug', () => {
  it('reads "Kampagne: Launch" with the raw ids only on the hover title', () => {
    const campaigns = [{ id: 'launch', active: true, posts: [liScope, tgReview] }];
    const { container } = render(wrap(<Freigaben campaigns={campaigns} onOpen={() => {}} />));
    expect(container.textContent).not.toContain('li-scope');
    expect(container.textContent).not.toContain('tg-review');
    const meta = screen.getAllByText('Kampagne: Launch');
    expect(meta.length).toBeGreaterThanOrEqual(2);
    expect(meta.map((m) => m.getAttribute('title'))).toEqual(expect.arrayContaining(['launch / li-scope', 'launch / tg-review']));
  });

  it('the English pack drops the id too', () => {
    const campaigns = [{ id: 'launch', active: true, posts: [tgReview] }];
    const { container } = render(wrap(<Freigaben campaigns={campaigns} onOpen={() => {}} />, 'en'));
    expect(container.textContent).not.toContain('tg-review');
    expect(screen.getAllByText('Campaign: Launch').length).toBeGreaterThan(0);
  });
});
