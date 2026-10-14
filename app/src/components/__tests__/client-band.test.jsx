import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi } from 'vitest';
import { axeClean } from '../../test-utils/axe.js';
import ClientBand from '../ClientBand.jsx';
import PostDetail from '../PostDetail.jsx';
import { ConfirmProvider } from '../ui/confirm.jsx';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { I18nProvider } from '../../lib/i18n.js';
import { bestContrastOn, parseHex } from '../../lib/theme.js';

// B4 — always-on per-client header band. ClientBand is purely presentational: it
// is handed the active client (or null) and renders the displayName + logo/monogram
// on an accent tint, contrast-safe foreground (bestContrastOn). It is read-only
// signage (switching stays in the sidebar / Cmd-K), so it carries NO switch control.

// PostDetail renders the band in its header; these stubs let it mount (ClientBand itself
// reads no API).
vi.mock('../../lib/api.js', () => ({
  useInsights: () => ({ data: undefined }),
  useActiveClient: () => ({ activeClient: { id: 'acme', displayName: 'Acme Retail', accent: '#22566d' }, activeClientId: 'acme' }),
  usePendpostHealth: () => ({ data: undefined }),
  useConfig: () => ({ data: null }),
  useAccounts: () => ({ data: { meta: { paused: false } } }),
  usePlatformValidate: () => ({ data: undefined }),
  useRedditFlairs: () => ({ data: undefined, isLoading: false }),
  usePresubmitCheck: () => ({ data: undefined }),
  useValidateMedia: () => ({ data: undefined }),
  useAssets: () => ({ data: { dir: 'data/media', assets: [] } }),
  approvePost: vi.fn(),
  rejectPost: vi.fn(),
  runPublishDue: vi.fn(),
  deletePost: vi.fn(),
  unschedulePost: vi.fn(),
  reschedulePost: vi.fn(),
  markPosted: vi.fn(),
  verifyPost: vi.fn(),
  setCoverFrame: vi.fn(),
  uploadCover: vi.fn(),
  clearCover: vi.fn(),
  updatePost: vi.fn(),
}));

function renderBand(props = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <I18nProvider locale="en">
      <QueryClientProvider client={qc}>
        <TooltipProvider>
          <ClientBand {...props} />
        </TooltipProvider>
      </QueryClientProvider>
    </I18nProvider>,
  );
}

const ACME = { id: 'acme', displayName: 'Acme Retail', status: 'active', accent: '#22566d' };

describe('ClientBand', () => {
  it('renders the active client displayName', () => {
    renderBand({ client: ACME });
    expect(screen.getByText('Acme Retail')).toBeInTheDocument();
  });

  it('tints an element with the client accent and uses the contrast-safe foreground', () => {
    const { container } = renderBand({ client: ACME });
    // jsdom serializes inline style colors to rgb(); compare on the parsed RGB so
    // the assertion is independent of hex-vs-rgb representation.
    const toRgb = (hex) => {
      const c = parseHex(hex);
      return `rgb(${c.r}, ${c.g}, ${c.b})`;
    };
    const accentRgb = toRgb(ACME.accent);
    // Some element carries the client accent as a background color.
    const tinted = [...container.querySelectorAll('*')].find((el) => el.style.backgroundColor === accentRgb);
    expect(tinted).toBeTruthy();
    // The contrast-safe foreground (bestContrastOn) is applied for text on the accent.
    const fgRgb = toRgb(bestContrastOn(parseHex(ACME.accent)).fg);
    const usesContrast = [...container.querySelectorAll('*')].some((el) => el.style.color === fgRgb);
    expect(usesContrast).toBe(true);
  });

  it('degrades to a neutral no-client state without crashing and never implies a wrong client', () => {
    const { container } = renderBand({ client: null });
    // No throw, something renders, and no stale/other client name leaks in.
    expect(container).toBeTruthy();
    expect(screen.queryByText('Acme Retail')).not.toBeInTheDocument();
    // A neutral "no client" label is shown (English baseline).
    expect(screen.getByText(/no project/i)).toBeInTheDocument();
  });

  it('does not crash on a registry-error / undefined client', () => {
    expect(() => renderBand({ client: undefined })).not.toThrow();
  });

  // Phase 3 D13: the "Active project" micro-label is gone. The accent-tinted band with the
  // project's avatar and name is the signage; the label only restated it (and already hid
  // below lg without any loss). Screen readers keep the full sentence via aria-label.
  it('shows no "Active project" label, only the project; the group name keeps the meaning', () => {
    renderBand({ client: ACME });
    expect(screen.queryByText(/active project/i)).not.toBeInTheDocument();
    expect(screen.getByText('Acme Retail')).toBeInTheDocument();
    expect(screen.getByRole('group', { name: /active project: acme retail/i })).toBeInTheDocument();
  });

  it('the no-client state says only "No project selected", no label in front of it', () => {
    renderBand({ client: null });
    expect(screen.queryByText(/active project/i)).not.toBeInTheDocument();
    expect(screen.getByRole('group', { name: /no project/i })).toHaveTextContent(/^No project selected$/);
  });

  it('never dims the contrast-safe fg with opacity', () => {
    const { container } = renderBand({ client: ACME });
    expect([...container.querySelectorAll('*')].some((el) => /(^|\s)opacity-/.test(el.getAttribute('class') || ''))).toBe(false);
  });

  it('has no axe violations (active client)', async () => {
    const { container } = renderBand({ client: ACME });
    expect(await axeClean(container)).toHaveNoViolations();
  });

  it('has no axe violations (no client)', async () => {
    const { container } = renderBand({ client: null });
    expect(await axeClean(container)).toHaveNoViolations();
  });
});

describe('PostDetail header project (D13)', () => {
  it('names the project without the "Aktives Projekt" label', () => {
    const post = {
      id: 'p1', campaign: 'launch', caption: 'Hallo', platforms: ['linkedin'], approval: 'approved', status: 'planned',
      scheduledAt: '2099-06-01T10:00:00Z', type: 'text', rev: 1, executionMode: 'fully-scheduled', image: null, ids: {},
      derivedState: 'waiting-due', media: { file: null, exists: false, items: [] },
    };
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <I18nProvider locale="de-CH">
          <TooltipProvider>
            <ConfirmProvider>
              <PostDetail post={post} onClose={() => {}} onEdit={() => {}} onNavigate={() => {}} />
            </ConfirmProvider>
          </TooltipProvider>
        </I18nProvider>
      </QueryClientProvider>,
    );
    const header = screen.getByRole('dialog').querySelector('header');
    expect(header).toHaveTextContent('Acme Retail');
    expect(header).not.toHaveTextContent('Aktives Projekt');
  });
});
