import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi } from 'vitest';
import ActivityView from '../Activity.jsx';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { I18nProvider } from '../../lib/i18n.js';

// A cloud copy that failed after a RECONNECT (lib/writes.mjs resealAfterReconnect,
// errorCode cloud_reseal_failed_reconnect) is not a renewal: no renewal will retry it.
// Its row says "reconnected" and routes to the cloud page (Re-sync now). The renewal's
// own failure (cloud_reseal_failed) keeps its "tries again on the next renewal" sentence.
const ACTIVITY = [
  { ts: '2026-10-07T09:00:02.000Z', action: 'token-refresh', ok: false, platform: 'linkedin', errorCode: 'cloud_reseal_failed_reconnect', errorMessage: 'linkedin reconnected locally, but handing the new sign-in to the cloud failed (cloud down). Choose Re-sync now on the cloud page to retry.' },
  { ts: '2026-10-07T09:00:01.000Z', action: 'token-refresh', ok: false, platform: 'x', errorCode: 'cloud_reseal_failed', errorMessage: 'x token renewed locally, but handing it to the cloud failed (cloud down). pendpost tries again on the next renewal.' },
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

describe('Activity: a failed cloud copy after a reconnect', () => {
  it('says reconnected (not renewed) and names Re-sync now', () => {
    renderActivity();
    expect(screen.getByText(/LinkedIn is reconnected, but pendpost could not update the cloud copy\. .*Re-sync now/)).toBeTruthy();
    expect(screen.getByText(/X renewed its sign-in, but pendpost could not update the cloud copy\. It tries again on the next renewal\./)).toBeTruthy();
  });

  it('routes its one fix to the cloud page; the renewal row gets no button', () => {
    const onNavigate = vi.fn();
    renderActivity('en', { onNavigate });
    const buttons = screen.getAllByRole('button', { name: /Open cloud service/ });
    expect(buttons).toHaveLength(1);
    expect(screen.queryByRole('button', { name: /Fix in Setup/ })).toBeNull();
    fireEvent.click(buttons[0]);
    expect(onNavigate).toHaveBeenCalledWith('cloud');
  });

  it('de-CH reads localized, no eszett, no em dash', () => {
    const { container } = renderActivity('de-CH');
    expect(screen.getByText(/LinkedIn ist neu verbunden/)).toBeTruthy();
    expect(screen.getAllByRole('button', { name: /Cloud-Service öffnen/ })).toHaveLength(1);
    expect(container.textContent).not.toMatch(/ß|—|–/);
  });
});
