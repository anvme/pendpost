import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Insights from '../Insights.jsx';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { ConfirmProvider } from '../ui/confirm.jsx';
import { I18nProvider } from '../../lib/i18n.js';

// The raw-error sweep: every Insights failure the owner sees is one plain sentence from the
// single mapper (humanizeAction); the server's English line never renders inline, it rides the
// house "?" beside the sentence. A message-less error still leaves the sentence.
let insightsState;
const saveConfigMock = vi.fn();

vi.mock('../../lib/api.js', () => ({
  useInsights: () => insightsState,
  useDigest: () => ({ data: null }),
  fetchInsights: vi.fn(() => Promise.resolve({ ok: true, fetched: 0, failed: 0, results: [] })),
  useConfig: () => ({ data: { rev: 3, posting: { insights: { meteredAuto: ['x'] } } } }),
  usePendpostHealth: () => ({ data: { setup: { platforms: [{ platform: 'x', status: 'connected', validation: { state: 'live' } }] } } }),
  usePlans: () => ({ data: { campaigns: [] } }),
  saveConfig: (...a) => saveConfigMock(...a),
}));

function renderInsights(locale = 'en') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <I18nProvider locale={locale}>
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

const moreAbout = () => screen.getByRole('button', { name: /more about this/i });

beforeEach(() => {
  insightsState = { data: { lastFetch: null, items: [], metricLabels: {} }, isLoading: false, isError: false, error: null };
  saveConfigMock.mockReset();
});

describe('Insights failures speak a plain sentence', () => {
  it('a failed read without a message shows the plain fallback sentence', () => {
    insightsState = { data: undefined, isLoading: false, isError: true, error: new Error() };
    renderInsights();
    expect(screen.getByText('The server did not respond.')).toBeInTheDocument();
  });

  it('a failed read with an English server line keeps it behind the "?"', () => {
    insightsState = { data: undefined, isLoading: false, isError: true, error: new Error('/api/insights: HTTP 500') };
    renderInsights();
    expect(screen.getByText('The server did not respond.')).toBeInTheDocument();
    expect(screen.queryAllByText(/HTTP 500/).every((el) => el.classList.contains('sr-only'))).toBe(true);
    expect(moreAbout()).toHaveAccessibleDescription('/api/insights: HTTP 500');
  });

  it('a failed X auto-refresh save says the plain sentence, the server line rides the "?"', async () => {
    saveConfigMock.mockRejectedValueOnce(new Error('HTTP 500 internal'));
    const user = userEvent.setup();
    renderInsights();
    await user.click(screen.getByRole('button', { name: /analytics settings/i }));
    await user.click(screen.getByRole('switch', { name: /include x in the daily refresh/i }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Could not save.');
    expect(alert).not.toHaveTextContent(/HTTP 500/);
    expect(moreAbout()).toHaveAccessibleDescription('HTTP 500 internal');
  });

  it('a message-less X auto-refresh save failure still shows the plain sentence', async () => {
    saveConfigMock.mockRejectedValueOnce(new Error());
    const user = userEvent.setup();
    renderInsights();
    await user.click(screen.getByRole('button', { name: /analytics settings/i }));
    await user.click(screen.getByRole('switch', { name: /include x in the daily refresh/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not save.');
  });
});
