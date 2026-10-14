import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Insights from '../Insights.jsx';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { ConfirmProvider } from '../ui/confirm.jsx';
import { I18nProvider } from '../../lib/i18n.js';

// A refresh where some lanes failed must not say "Refreshed": the button settles back
// and one muted line names the lanes that did not update (the server's failedLanes). A
// disabled Google API keeps its own "turn on" line, so it is not named twice.
const fetchInsightsMock = vi.fn();

vi.mock('../../lib/api.js', () => ({
  useInsights: () => ({ data: { lastFetch: null, items: [], metricLabels: {} }, isLoading: false, isError: false, error: null }),
  useDigest: () => ({ data: null }),
  fetchInsights: (...a) => fetchInsightsMock(...a),
  useConfig: () => ({ data: { rev: 1, posting: { insights: { meteredAuto: [] } } } }),
  usePendpostHealth: () => ({ data: { setup: { platforms: [] } } }),
  usePlans: () => ({ data: { campaigns: [] } }),
  saveConfig: vi.fn(),
}));

function renderInsights() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <I18nProvider locale="en">
      <QueryClientProvider client={qc}>
        <TooltipProvider>
          <ConfirmProvider>
            <Insights active platformFilter={[]} campaignFilter="all" />
          </ConfirmProvider>
        </TooltipProvider>
      </QueryClientProvider>
    </I18nProvider>,
  );
}

beforeEach(() => fetchInsightsMock.mockReset());

describe('Insights refresh with failed lanes', () => {
  it('names the lanes that could not refresh and never flashes "Refreshed"', async () => {
    fetchInsightsMock.mockResolvedValue({
      ok: true, fetched: 3, failed: 2, results: [{ ok: false, platform: 'youtube', error: 'api_disabled' }],
      failedLanes: [{ lane: 'linkedin', reason: 'needs_scope' }, { lane: 'meta', reason: 'error' }, { lane: 'youtube', reason: 'api_disabled' }],
    });
    const user = userEvent.setup();
    renderInsights();
    await user.click(screen.getAllByRole('button', { name: /refresh analytics/i })[0]);
    expect(await screen.findByText('Not refreshed: LinkedIn, Meta.')).toBeInTheDocument();
    expect(screen.queryByText('Refreshed')).toBeNull();
    // The disabled API keeps its own line with the one fix.
    expect(screen.getByText(/YouTube Analytics is turned off/)).toBeInTheDocument();
  });

  it('a clean refresh still says "Refreshed" and shows no partial line', async () => {
    fetchInsightsMock.mockResolvedValue({ ok: true, fetched: 3, failed: 0, results: [], failedLanes: [] });
    const user = userEvent.setup();
    renderInsights();
    await user.click(screen.getAllByRole('button', { name: /refresh analytics/i })[0]);
    await waitFor(() => expect(screen.getByText('Refreshed')).toBeInTheDocument());
    expect(screen.queryByText(/Not refreshed/)).toBeNull();
  });
});
