import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi } from 'vitest';
import { ListView, PostCard } from '../Planner.jsx';
import Freigaben from '../Freigaben.jsx';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { ConfirmProvider } from '../ui/confirm.jsx';
import { I18nProvider } from '../../lib/i18n.js';

// Final judge finding 9 (375px): status pills clipped at the card edge ("Du postest selbs")
// and List / Freigaben titles truncated to 4 to 6 characters because the pill shared their
// line. jsdom has no layout, so these pin the CSS contract; the browser flows measure it.
//  - The one status pill never grows past its container (max-w-full) and its word wraps
//    instead of being cut, so a narrow Week card shows the whole word.
//  - A List row whose pill shows on phone (an attention word) moves that pill to its own
//    line under the title below md (order-last + basis-full), so the title keeps the width.
//  - The Freigaben card stacks the pill under the headline below sm.

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
const pending = {
  id: 'p-pending', campaign: 'launch', title: 'Launch week recap with a long title', caption: 'Body.',
  platforms: ['linkedin'], type: 'text', approval: 'pending', derivedState: 'draft',
  scheduledAt: '2099-07-01T10:00:00Z', image: null, media: NO_MEDIA,
};
const approved = { ...pending, id: 'p-ok', title: 'Calm approved post', approval: 'approved', derivedState: 'waiting-due' };

const wrap = (ui) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <I18nProvider locale="de-CH">
      <TooltipProvider>
        <ConfirmProvider>{ui}</ConfirmProvider>
      </TooltipProvider>
    </I18nProvider>
  </QueryClientProvider>
);
const pillOf = (word) => screen.getAllByText(word)[0].closest('span.rounded-full');

describe('status pill fits its container', () => {
  it('the Week card pill is capped at the card width and wraps its word, never cut', () => {
    render(wrap(<PostCard post={pending} onSelect={() => {}} lane={{}} />));
    const pill = pillOf('Wartet auf Freigabe');
    expect(pill.className).toContain('max-w-full');
    const label = screen.getAllByText('Wartet auf Freigabe')[0];
    expect(label.className).not.toContain('truncate');
  });
});

describe('List row on phone: an attention pill gets its own line', () => {
  it('attention word: the pill slot drops under the title below md', () => {
    render(wrap(<ListView posts={[pending]} onSelect={() => {}} loading={false} lane={{}} />));
    const pill = pillOf('Wartet auf Freigabe');
    const slot = pill.parentElement;
    for (const c of ['order-last', 'basis-full', 'md:order-none', 'md:basis-auto']) expect(slot.className).toContain(c);
    expect(pill.closest('li').className).toContain('flex-wrap');
  });

  it('settled word: the slot is layout-neutral (the pill stays hidden on phone as before)', () => {
    render(wrap(<ListView posts={[approved]} onSelect={() => {}} loading={false} lane={{}} />));
    const pill = pillOf('Freigegeben');
    expect(pill.parentElement.className).toContain('contents');
    expect(pill.className).toContain('hidden md:inline-flex');
  });
});

describe('Freigaben card on phone: the pill stacks under the headline', () => {
  it('headline row is a column below sm and a row from sm', () => {
    const campaigns = [{ id: 'launch', active: true, posts: [pending] }];
    render(wrap(<Freigaben campaigns={campaigns} onOpen={() => {}} />));
    const headline = screen.getAllByText('Launch week recap with a long title').find((el) => el.className.includes('font-bold'));
    const row = headline.parentElement;
    expect(row.className).toContain('flex-col');
    expect(row.className).toContain('sm:flex-row');
  });
});
