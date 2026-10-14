import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi } from 'vitest';
import ActivityView from '../Activity.jsx';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { I18nProvider } from '../../lib/i18n.js';
import en from '../../locales/en.json';
import deCH from '../../locales/de-CH.json';

// A scheduled Radar scan that a spend limit stopped (the owner's daily agent budget, or the
// agent subscription's weekly/session limit) is not a failure: nothing to fix, the next scan
// runs by itself. The engine now logs it ok:true (lib/radar-sweep.mjs scanActivityOutcome);
// rows written before that fix carry ok:false. Both must render as a neutral note with a
// localized sentence, never a red X, and never count as a failure in "failures only".
const ACTIVITY = [
  { ts: '2026-10-07T05:00:00.000Z', action: 'radar-agent-scan', ok: false, platform: null, campaign: null, postId: null, errorCode: 'budget', errorMessage: 'daily agent budget reached (1/1) - the scheduled scan was skipped' },
  { ts: '2026-10-06T05:00:00.000Z', action: 'radar-agent-scan', ok: true, platform: null, campaign: null, postId: null, errorCode: 'limit', errorMessage: "You've hit your weekly limit - resets 5am" },
  // The old aggregate insights row (pre per-lane rows): history, neutral, no fix button.
  { ts: '2026-10-05T05:00:00.000Z', action: 'insights-fetch', ok: false, platform: null, campaign: null, postId: null, errorCode: 'engine_failure', errorMessage: '110 fetch(es) failed: meta error, linkedin needs_scope, youtube api_disabled', actor: 'pendpost' },
];

vi.mock('../../lib/api.js', () => ({
  useActivity: () => ({ data: { activity: ACTIVITY }, isLoading: false, isError: false }),
}));

function renderActivity(locale, failuresOnly = false) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <I18nProvider locale={locale}>
        <TooltipProvider>
          <ActivityView active platformFilter={[]} failuresOnly={failuresOnly} actionGroups={[]} onOpenPost={() => {}} />
        </TooltipProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );
}

describe('Activity: budget / usage-limit radar skips are neutral notes', () => {
  it('renders the localized neutral sentences, not the raw English line, and no red failure tone', () => {
    renderActivity('de-CH');
    const budget = screen.getByText(deCH.strings['activity.note.radarBudget']);
    const limit = screen.getByText(deCH.strings['activity.note.agentLimit']);
    expect(budget.className).not.toMatch(/text-red/);
    expect(limit.className).not.toMatch(/text-red/);
    // The raw English line is never the visible note; it only rides the house "?" (sr-only).
    for (const el of screen.queryAllByText(/daily agent budget reached/)) expect(el.className).toMatch(/sr-only/);
  });

  it('renders the English sentences under en', () => {
    renderActivity('en');
    expect(screen.getByText(en.strings['activity.note.radarBudget'])).toBeTruthy();
    expect(screen.getByText(en.strings['activity.note.agentLimit'])).toBeTruthy();
  });

  it('never lists them under failures only', () => {
    renderActivity('en', true);
    expect(screen.queryByText(en.strings['activity.note.radarBudget'])).toBeNull();
    expect(screen.queryByText(en.strings['activity.note.agentLimit'])).toBeNull();
  });

  it('reads the old aggregate insights row as neutral history: no fix button, no raw failure line', () => {
    renderActivity('de-CH');
    expect(screen.queryByRole('button', { name: deCH.strings['activity.fix.apiDisabled'] })).toBeNull();
    for (const el of screen.queryAllByText(/fetch\(es\) failed/)) expect(el.className).toMatch(/sr-only/);
  });

  it('never lists the old aggregate insights row under failures only', () => {
    renderActivity('en', true);
    expect(screen.queryByText(en.strings['activity.note.insightsLegacy'])).toBeNull();
  });
});
