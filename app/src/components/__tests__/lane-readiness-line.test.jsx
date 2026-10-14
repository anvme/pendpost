import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import LaneReadinessLine, { SETUP_LANE, BLUESKY_ENV_VAR } from '../radar/LaneReadinessLine.jsx';
import { I18nProvider } from '../../lib/i18n.js';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { TAP_TARGET } from '../ui/recipes.js';
import { replyLaneState } from '../../lib/format.js';

// LaneReadinessLine is the ONE presentational unit for a reply lane's state + its single
// recovering action, shared by the Radar automation strip and the autonomy ledger so both
// tell the same truth in the same words. This suite locks the reason -> line + action mapping
// (the mapping that used to live only in the ledger's PlatformRow) and the two Radar-only
// extras: copy-only capability truth and the bluesky env-only not-connected line.

const engageProbeMock = vi.fn(() => Promise.resolve({ ok: true, usable: true }));
const engageConfirmHandleMock = vi.fn(() => Promise.resolve({ ok: true }));
const resumeLaneMock = vi.fn(() => Promise.resolve({ ok: true }));

vi.mock('../../lib/api.js', async (importOriginal) => {
  // The REAL error helpers (the one plain path), never a stub that could drift from it.
  const real = await importOriginal();
  return {
    engageProbe: (...a) => engageProbeMock(...a),
    engageConfirmHandle: (...a) => engageConfirmHandleMock(...a),
    resumeLane: (...a) => resumeLaneMock(...a),
    errText: real.errText,
    errAlert: real.errAlert,
    errReason: real.errReason,
  };
});

function renderLine(props) {
  return render(
    <I18nProvider>
      <TooltipProvider>
        <LaneReadinessLine label="Mastodon" clientName="Acme" onNavigate={props?.onNavigate} onRefresh={props?.onRefresh} {...props} />
      </TooltipProvider>
    </I18nProvider>,
  );
}

beforeEach(() => {
  engageProbeMock.mockClear();
  engageConfirmHandleMock.mockClear();
  resumeLaneMock.mockClear();
});

// ONE judge for a reply lane's readiness word (final-a6): the Radar lane list and the Settings
// ledger used to derive it twice. Radar forced "Not connected" from the account read while the
// ledger read the probe runtime, so the same credential-less Bluesky said "Not connected" on one
// surface and "Not checked yet" on the other. replyLaneState folds the engine's stored-credential
// fact (GET /api/engage `credential`) with the probe verdict (`reason`), and both surfaces call it.
describe('replyLaneState: the one readiness judge both surfaces call', () => {
  it('missing credential reads no_credential before any probe; a probe verdict (what the engine acts on) keeps its word', () => {
    expect(replyLaneState({ reason: 'checking', credential: 'none' })).toBe('no_credential');
    expect(replyLaneState({ credential: 'none' })).toBe('no_credential');
    expect(replyLaneState({ reason: 'ready', usable: true, credential: 'none' })).toBe('ready');
  });
  it('a credential present but never probed reads not_checked; checking only while a probe is in flight', () => {
    expect(replyLaneState({ reason: 'checking', credential: 'stored' })).toBe('not_checked');
    expect(replyLaneState({ reason: 'checking', credential: 'stored' }, { probing: true })).toBe('checking');
    // a browser lane (no stored fact) and a runtime that has not answered yet are not_checked too
    expect(replyLaneState({ reason: 'checking', credential: null })).toBe('not_checked');
    expect(replyLaneState(undefined)).toBe('not_checked');
  });
  it('a probe verdict keeps its own word (the existing failure wording)', () => {
    for (const reason of ['no_credential', 'not_logged_in', 'wrong_account', 'confirm_handle', 'cooling_down', 'ready']) {
      expect(replyLaneState({ reason, credential: 'stored' })).toBe(reason);
    }
  });
  it('a credential the Setup liveness probe already proved reads ready (the same probe engage runs for an API lane)', () => {
    expect(replyLaneState({ reason: 'checking', credential: 'live' })).toBe('ready');
  });
});

describe('LaneReadinessLine: the credential fact before any probe', () => {
  it('bluesky with no app password and nothing probed: Not connected + the copy .env route, never Not checked yet', () => {
    renderLine({ lane: 'bluesky', label: 'Bluesky', runtime: { reason: 'checking', credential: 'none' } });
    expect(screen.getByText('Not connected')).toBeInTheDocument();
    expect(screen.queryByText('Not checked yet')).toBeNull();
    expect(screen.getByRole('button', { name: /copy config lines/i })).toBeInTheDocument();
  });
  it('a Setup-card lane with nothing stored: Not connected + Connect', () => {
    renderLine({ lane: 'reddit', label: 'Reddit', runtime: { reason: 'checking', credential: 'none' } });
    expect(screen.getByText('Not connected')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Connect' })).toBeInTheDocument();
  });
  it('a stored credential nothing probed: Not checked yet + Check now', () => {
    renderLine({ lane: 'bluesky', label: 'Bluesky', runtime: { reason: 'checking', credential: 'stored' } });
    expect(screen.getByText('Not checked yet')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Check now' })).toBeInTheDocument();
  });
  it('a credential the Setup probe proved: Ready, no control', () => {
    renderLine({ lane: 'mastodon', runtime: { reason: 'checking', credential: 'live' } });
    expect(screen.getByText('Ready')).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
  });
});

describe('LaneReadinessLine: reason -> line + one action', () => {
  it('ready: says Ready, offers no control', () => {
    renderLine({ lane: 'mastodon', runtime: { reason: 'ready', usable: true } });
    expect(screen.getByText('Ready')).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('never probed (checking, no lastProbeAt): "Not checked yet" + a Check now that probes', async () => {
    const onRefresh = vi.fn();
    renderLine({ lane: 'mastodon', runtime: { reason: 'checking' }, onRefresh });
    expect(screen.getByText('Not checked yet')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Check now' }));
    expect(engageProbeMock).toHaveBeenCalledWith('mastodon');
  });

  it('no_credential on a Setup-card lane: one Connect that deep-links to Setup', async () => {
    const onNavigate = vi.fn();
    renderLine({ lane: 'reddit', label: 'Reddit', runtime: { reason: 'no_credential' }, onNavigate });
    expect(screen.getByText('Not connected')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Connect' }));
    expect(onNavigate).toHaveBeenCalledWith('setup', SETUP_LANE.reddit);
  });

  // fd798592: the env var name left the inline line on every surface. judge round 2: the
  // detail sits behind a VISIBLE "?" trigger (InfoTip: hover, tap, keyboard), and the row is no
  // longer a dead end - it carries the Radar notice's one route, "Copy .env lines".
  it('no_credential on bluesky (no Setup card): Not connected, env vars behind the ? trigger, one copy action, never a dead Connect', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(window.navigator, 'clipboard', { value: { writeText }, configurable: true });
    renderLine({ lane: 'bluesky', label: 'Bluesky', runtime: { reason: 'no_credential' } });
    expect(screen.getByText('Not connected')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Connect' })).toBeNull();
    expect(screen.queryByText(new RegExp(BLUESKY_ENV_VAR), { ignore: '.sr-only' })).not.toBeInTheDocument();
    const info = screen.getByRole('button', { name: /more about this/i });
    for (const cls of TAP_TARGET.split(' ')) expect(info.className).toContain(cls);
    await user.click(info); // a tap / Enter opens it, not only hover
    await waitFor(() => expect(document.querySelector('[data-infotip-content]')).toHaveTextContent('BLUESKY_IDENTIFIER, BLUESKY_APP_PASSWORD'));
    const copy = screen.getByRole('button', { name: /copy config lines/i });
    for (const cls of TAP_TARGET.split(' ')) expect(copy.className).toContain(cls);
    await user.click(copy);
    expect(writeText).toHaveBeenCalledWith('BLUESKY_IDENTIFIER=\nBLUESKY_APP_PASSWORD=');
    expect(await screen.findByText(/^copied$/i)).toBeInTheDocument();
  });

  // Final judge (release round): at 375px the copy action wraps under "Not connected ?" and its
  // 44px box covered the lower half of the "?" (measured unobstructed 44x26). A row that holds
  // the "?" wraps with a 24px row gap, so the two boxes meet instead of overlapping; a line with
  // no "?" keeps the tight gap (the gap only exists once the row actually wraps).
  it('a line with the ? trigger wraps with room for both 44px boxes; a plain line keeps the tight gap', () => {
    const { unmount } = renderLine({ lane: 'bluesky', label: 'Bluesky', runtime: { reason: 'no_credential' } });
    const info = screen.getByRole('button', { name: /more about this/i });
    const row = info.closest('span.flex');
    expect(row.className).toMatch(/\bgap-y-6\b/);
    unmount();
    renderLine({ lane: 'reddit', label: 'Reddit', runtime: { reason: 'no_credential' } });
    const plain = screen.getByRole('button', { name: 'Connect' }).closest('span.flex');
    expect(plain.className).toMatch(/\bgap-y-1\b/);
  });

  it('not_logged_in: names the platform + Check again probes', async () => {
    renderLine({ lane: 'linkedin', label: 'LinkedIn', runtime: { reason: 'not_logged_in' } });
    expect(screen.getByText(/Not logged in/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Check again' }));
    expect(engageProbeMock).toHaveBeenCalledWith('linkedin');
  });

  it('wrong_account: names who is logged in + Check again', () => {
    renderLine({ lane: 'x', label: 'X', runtime: { reason: 'wrong_account', handleSeen: 'someoneelse' } });
    expect(screen.getByText(/someoneelse/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Check again' })).toBeInTheDocument();
  });

  it('confirm_handle: the handle question with Yes/No that write the confirm', async () => {
    renderLine({ lane: 'x', label: 'X', runtime: { reason: 'confirm_handle', handleSeen: 'acme' } });
    expect(screen.getByText(/@acme/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Yes' }));
    expect(engageConfirmHandleMock).toHaveBeenCalledWith('x', true);
  });

  it('cooling_down: names the window + Resume now', async () => {
    renderLine({ lane: 'reddit', label: 'Reddit', runtime: { reason: 'cooling_down', pausedUntil: '2026-09-16T20:00:00.000Z', pauseReason: 'platform_limit' } });
    expect(screen.getByText(/Cooling down/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Resume now' }));
    expect(resumeLaneMock).toHaveBeenCalledWith('reddit');
  });

  it('copyOnly: says draft-only, offers no arm action (capability truth)', () => {
    renderLine({ lane: 'x', label: 'X', copyOnly: true, runtime: { reason: 'ready' } });
    expect(screen.getByText('Draft only, no auto-reply here')).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
  });
});

// Raw-error sweep G1 + wave 2g F4: a failed lane verb is one plain sentence that names ITS
// action (check / confirm / resume, never "Could not check" for a Resume). The reason follows
// only when it is a known sentence, so an unknown error never reads doubled ("...: That did
// not work"). The server's raw line rides the shared "?" only, never inline.
describe('LaneReadinessLine - a failed verb says a plain sentence, raw line behind the "?"', () => {
  it('a failed check with an English server error: the check sentence, raw line behind the "?"', async () => {
    engageProbeMock.mockImplementationOnce(() => Promise.reject(new Error('HTTP 500 internal')));
    renderLine({ lane: 'mastodon', runtime: { reason: 'checking' } });
    await userEvent.click(screen.getByRole('button', { name: 'Check now' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/^Could not check Mastodon\.$/);
    const tip = screen.getByRole('button', { name: /more about this/i });
    expect(document.getElementById(tip.getAttribute('aria-describedby'))?.textContent).toBe('HTTP 500 internal');
  });

  it('a failed check with a known reason keeps that reason', async () => {
    engageProbeMock.mockImplementationOnce(() => Promise.reject(new TypeError('Load failed')));
    renderLine({ lane: 'mastodon', runtime: { reason: 'checking' } });
    await userEvent.click(screen.getByRole('button', { name: 'Check now' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not check Mastodon. Could not reach your local pendpost. Is it running?');
  });

  it('a failed Resume says resume, with no "?" for a message-less error', async () => {
    resumeLaneMock.mockImplementationOnce(() => Promise.reject(new Error()));
    renderLine({ lane: 'mastodon', runtime: { reason: 'cooling_down', pausedUntil: '2026-09-16T20:00:00.000Z', pauseReason: 'platform_limit' } });
    await userEvent.click(screen.getByRole('button', { name: 'Resume now' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/^Could not resume Mastodon\.$/);
    expect(screen.queryByRole('button', { name: /more about this/i })).toBeNull();
  });

  it('a failed Yes/No says the answer was not saved', async () => {
    engageConfirmHandleMock.mockImplementationOnce(() => Promise.reject(new Error('HTTP 500 internal')));
    renderLine({ lane: 'x', label: 'X', runtime: { reason: 'confirm_handle', handleSeen: 'acme' } });
    await userEvent.click(screen.getByRole('button', { name: 'No' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/^Could not save your answer for X\.$/);
    expect(alert).not.toHaveTextContent(/HTTP 500/);
  });
});
