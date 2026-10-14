import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi } from 'vitest';
import Insights from '../Insights.jsx';
import ActivityView from '../Activity.jsx';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { ConfirmProvider } from '../ui/confirm.jsx';
import { I18nProvider } from '../../lib/i18n.js';

// A lane that has not refreshed for more than 2 days (lib/insights.mjs staleLanes) is named
// on the Insights page and on the nightly summary row, so an old figure never reads current.
const STALE = [{ lane: 'linkedin', reason: 'error', since: '2026-10-10T08:47:00.000Z' }];
const ACTIVITY = [
  { ts: '2026-10-13T05:10:00.000Z', action: 'insights-fetch', ok: false, platform: null, errorCode: 'insights_stale', errorMessage: 'Statistics have not refreshed for more than 2 days: LinkedIn since Oct 10, 2026.', lanes: STALE },
  { ts: '2026-10-12T05:10:00.000Z', action: 'insights-fetch', ok: true, platform: null, errorCode: 'insights_offline', errorMessage: 'No network for Meta', lanes: [{ lane: 'meta' }] },
];

vi.mock('../../lib/api.js', () => ({
  useInsights: () => ({ data: { lastFetch: '2026-10-10T08:47:00.000Z', items: [], metricLabels: {}, stale: STALE }, isLoading: false, isError: false, error: null }),
  useDigest: () => ({ data: null }),
  fetchInsights: vi.fn(),
  useConfig: () => ({ data: { rev: 1, posting: { insights: { meteredAuto: [] } } } }),
  usePendpostHealth: () => ({ data: { setup: { platforms: [] } } }),
  usePlans: () => ({ data: { campaigns: [] } }),
  saveConfig: vi.fn(),
  useActivity: () => ({ data: { activity: ACTIVITY }, isLoading: false, isError: false }),
}));

function wrap(node, locale = 'en') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <I18nProvider locale={locale}>
      <QueryClientProvider client={qc}>
        <TooltipProvider><ConfirmProvider>{node}</ConfirmProvider></TooltipProvider>
      </QueryClientProvider>
    </I18nProvider>,
  );
}

describe('stale insights lanes', () => {
  it('the Insights page names the stale lane and the date it stopped', () => {
    wrap(<Insights active platformFilter={[]} campaignFilter="all" />);
    expect(screen.getByTestId('insights-stale').textContent).toMatch(/Not refreshed for more than 2 days: LinkedIn since .*2026/);
  });

  it('de-CH reads in German', () => {
    wrap(<Insights active platformFilter={[]} campaignFilter="all" />, 'de-CH');
    expect(screen.getByTestId('insights-stale').textContent).toMatch(/Seit mehr als 2 Tagen nicht aktualisiert: LinkedIn seit /);
  });

  it('the nightly summary row says which lane is stale and since when, and offline in plain words', () => {
    wrap(<ActivityView active platformFilter={[]} failuresOnly={false} actionGroups={['system']} onOpenPost={() => {}} />);
    expect(screen.getByText(/Statistics have not refreshed for more than 2 days: LinkedIn since .*2026/)).toBeTruthy();
    expect(screen.getByText(/No network for Meta\. pendpost runs the statistics again/)).toBeTruthy();
  });
});
