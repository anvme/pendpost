import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi } from 'vitest';
import ActivityView from '../Activity.jsx';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { I18nProvider } from '../../lib/i18n.js';

// The insights sweep logs ONE row per lane, only when the lane's state changes
// (lib/insights.mjs). Each row reads as one plain sentence by lane + reason, and only a
// reason the owner can fix in one step carries a button:
//   youtube api_disabled -> "Turn on in Google Cloud"
//   linkedin needs_scope -> the pending Community Management application, NO button
//   meta error           -> the sanitized real reason, NO button
//   linkedin recovery    -> "LinkedIn statistics are back." (neutral)
const ACTIVITY = [
  { ts: '2026-10-07T05:10:04.000Z', action: 'insights-fetch', ok: true, platform: 'linkedin', errorCode: 'insights_recovered', errorMessage: 'LinkedIn statistics are back' },
  { ts: '2026-10-07T05:10:03.000Z', action: 'insights-fetch', ok: false, platform: 'youtube', errorCode: 'api_disabled', errorMessage: 'YouTube statistics are off because the API is turned off in Google Cloud: HTTP 403 accessNotConfigured', helpUrl: 'https://console.developers.google.com/apis/api/youtubeanalytics.googleapis.com/overview?project=1' },
  { ts: '2026-10-07T05:10:02.000Z', action: 'insights-fetch', ok: false, platform: 'linkedin', errorCode: 'needs_scope', errorMessage: 'LinkedIn statistics need a permission the app does not have yet: HTTP 403' },
  { ts: '2026-10-07T05:10:01.000Z', action: 'insights-fetch', ok: false, platform: 'meta', errorCode: 'error', errorMessage: 'Meta statistics could not refresh: Graph GET /1789: HTTP 400 unsupported get request', detail: 'Graph GET /1789: HTTP 400 unsupported get request' },
];

vi.mock('../../lib/api.js', () => ({
  useActivity: () => ({ data: { activity: ACTIVITY }, isLoading: false, isError: false }),
}));

function renderActivity(locale = 'en', props = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <I18nProvider locale={locale}>
        <TooltipProvider>
          <ActivityView active platformFilter={[]} failuresOnly={false} actionGroups={[]} onOpenPost={() => {}} {...props} />
        </TooltipProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );
}

describe('Activity: per-lane insights rows', () => {
  it('YouTube api_disabled offers the one fix: turn the API on in Google Cloud', () => {
    renderActivity();
    expect(screen.getByText(/YouTube statistics are paused: a Google service they need is turned off/)).toBeTruthy();
    expect(screen.getAllByRole('button', { name: /Turn on in Google Cloud/ })).toHaveLength(1);
  });

  it('LinkedIn needs_scope names the pending Community Management application, no reconnect', () => {
    renderActivity();
    expect(screen.getByText(/Community Management product/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Fix in Setup|Reconnect/ })).toBeNull();
  });

  it('Meta shows the sanitized real reason', () => {
    renderActivity();
    expect(screen.getByText(/Meta statistics could not refresh: Graph GET \/1789/)).toBeTruthy();
  });

  it('a recovery is one neutral "statistics are back" sentence (a system success, shown under the system chip)', () => {
    renderActivity('en', { actionGroups: ['system'] });
    expect(screen.queryByText('LinkedIn statistics are back.')).toBeTruthy();
  });

  it('de-CH reads localized, no eszett, no em dash', () => {
    const { container } = renderActivity('de-CH');
    expect(screen.getByText(/Community-Management-Produkt/)).toBeTruthy();
    expect(container.textContent).not.toMatch(/ß|\u2014/);
  });
});
