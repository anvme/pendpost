import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import Sidebar from '../components/Sidebar.jsx';
import { TooltipProvider } from '../components/ui/Tooltip.jsx';
import { I18nProvider } from '../lib/i18n.js';

vi.mock('../lib/api.js', () => ({
  setSchedulerRunning: vi.fn(() => Promise.resolve({ ok: true })),
  useSignals: () => ({ data: null }),
}));
vi.mock('../lib/cloud.js', () => ({
  useCloud: () => ({ data: null }),
  useCloudClients: () => ({ data: null }),
}));
vi.mock('../components/ClientSwitcher.jsx', () => ({ default: () => null }));

function renderSidebar(props) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <I18nProvider locale="de-CH">
      <QueryClientProvider client={qc}>
        <TooltipProvider>
          <Sidebar onNavigate={() => {}} onNew={() => {}} onOpenPost={() => {}} onShowOverdue={() => {}} {...props} />
        </TooltipProvider>
      </QueryClientProvider>
    </I18nProvider>,
  );
}

// Lanes in every tone the old rail chip painted: a failed probe (red), a
// not-connected lane (amber) and a healthy one (green).
const accounts = {
  meta: { configured: true, pageId: 'p', igUserId: 'i', live: { ok: true } },
  linkedin: { authenticated: true, live: { ok: false, detail: 'token expired' } },
  x: { authenticated: false },
  scheduler: { running: true },
};
const posting = { enabledPlatforms: ['facebook', 'instagram', 'linkedin', 'x'] };

// Final judge, blocker 2: the rail carried a textless chip (colour dot plus lane
// logos) that stated lane health by colour alone and spent green on a state that
// was not all-clear. The Einrichtung badge and the "Wartet auf dich" slot already
// carry that state in words, so the chip is gone.
describe('Sidebar without the textless lane-health chip', () => {
  it('renders no accounts chip and no colour status dot for lanes', () => {
    const { container } = renderSidebar({ accounts, posting, setupReady: false, setupIncomplete: 2 });
    expect(screen.queryByRole('button', { name: /Konten & Status/ })).toBeNull();
    // No lane-health dot in any tone anywhere in the rail.
    expect(container.querySelector('.bg-emerald-500, .bg-amber-500')).toBeNull();
  });

  it('keeps the lane state in words on the Einrichtung nav badge', () => {
    renderSidebar({ accounts, posting, setupReady: false, setupIncomplete: 2 });
    expect(screen.getByText('2', { selector: 'span[aria-hidden="true"]' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Einrichtung/ })).toHaveTextContent(/2/);
  });
});

// Phase 3 Tier-3 sweep: the delivery sub-line says "Lokal · aktiv" in plain words (no "60s" or
// "Zyklus" anywhere in the rail) and the last-run time wraps at the dot instead of being
// truncated mid-word ("Lokal · aktiv · Letzter La…").
describe('Sidebar delivery line', () => {
  it('reads "Lokal · aktiv" with the last run as its own unbroken fragment, never truncated', () => {
    const { container } = renderSidebar({
      accounts: { ...accounts, scheduler: { running: true, lastRun: '2026-09-26T08:02:00.000Z' } },
      posting,
      setupReady: true,
      setupIncomplete: 0,
    });
    const state = screen.getByText('Lokal · aktiv');
    const line = state.parentElement;
    expect(line.className.split(/\s+/)).not.toContain('truncate');
    expect(state.className.split(/\s+/)).toContain('whitespace-nowrap');
    const lastRun = [...line.children].find((el) => /^Letzter Lauf: /.test(el.textContent));
    expect(lastRun).toBeTruthy();
    expect(lastRun.className.split(/\s+/)).toContain('whitespace-nowrap');
    expect(container.textContent).not.toMatch(/60s|Zyklus|60-Sekunden/);
  });
});
