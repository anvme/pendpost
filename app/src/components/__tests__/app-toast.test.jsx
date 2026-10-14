import { render, screen, act, within } from '@testing-library/react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import AppToast, { showToast } from '../AppToast.jsx';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { I18nProvider } from '../../lib/i18n.js';

// The toast's announced region (role=alert / role=status) must hold the plain sentence only.
// A raw server/engine line may ride the shared InfoTip "?", which sits OUTSIDE that region,
// so its sr-only description is never read out as part of the alert.

function mount() {
  return render(
    <I18nProvider locale="en">
      <TooltipProvider>
        <AppToast />
      </TooltipProvider>
    </I18nProvider>,
  );
}

afterEach(() => { vi.useRealTimers(); });

describe('AppToast { text, raw } shape', () => {
  it('announces the text only; the raw line is the "?" description outside the alert', () => {
    mount();
    act(() => { showToast({ kind: 'error', text: { text: 'Delete failed.', raw: 'HTTP 500 internal' } }); });
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toBe('Delete failed.');
    expect(within(alert).queryByRole('button', { name: /more about this/i })).toBeNull();
    const tip = screen.getByRole('button', { name: /more about this/i });
    expect(tip).toHaveAccessibleDescription('HTTP 500 internal');
    expect(alert.contains(tip)).toBe(false);
    // The description node itself is outside the announced region too.
    const desc = document.getElementById(tip.getAttribute('aria-describedby'));
    expect(alert.contains(desc)).toBe(false);
    // The "?" carries the invisible 44px hit area.
    expect(tip.className).toMatch(/after:min-w-11/);
    expect(tip.className).toMatch(/after:h-11/);
  });

  it('accepts raw as a top-level field too (a spread humanizeAction result)', () => {
    mount();
    act(() => { showToast({ kind: 'error', text: 'Delete failed.', raw: 'relay down', known: false }); });
    expect(screen.getByRole('alert').textContent).toBe('Delete failed.');
    expect(screen.getByRole('button', { name: /more about this/i })).toHaveAccessibleDescription('relay down');
  });

  it('a plain string toast still renders as before, with no "?"', () => {
    mount();
    act(() => { showToast({ kind: 'error', text: 'Something broke.' }); });
    expect(screen.getByRole('alert')).toHaveTextContent('Something broke.');
    expect(screen.queryByRole('button', { name: /more about this/i })).toBeNull();
  });

  it('a { text } object with no raw renders no "?"', () => {
    mount();
    act(() => { showToast({ kind: 'error', text: { text: 'Delete failed.', raw: null } }); });
    expect(screen.getByRole('alert').textContent).toBe('Delete failed.');
    expect(screen.queryByRole('button', { name: /more about this/i })).toBeNull();
  });

  it('a toast carrying a raw line stays until dismissed, so the "?" stays reachable', () => {
    vi.useFakeTimers();
    mount();
    act(() => { showToast({ kind: 'error', text: { text: 'Delete failed.', raw: 'HTTP 500 internal' } }); });
    act(() => { vi.advanceTimersByTime(60000); });
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /more about this/i })).toBeInTheDocument();
    act(() => { screen.getByRole('button', { name: /close/i }).click(); });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('a plain error toast still leaves on its own', () => {
    vi.useFakeTimers();
    mount();
    act(() => { showToast({ kind: 'error', text: 'Something broke.' }); });
    act(() => { vi.advanceTimersByTime(9000); });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('a success toast keeps its action inside the status region', () => {
    mount();
    const onClick = vi.fn();
    act(() => { showToast({ text: 'Paused.', action: { label: 'Resume', onClick } }); });
    const status = screen.getByRole('status');
    expect(within(status).getByRole('button', { name: 'Resume' })).toBeInTheDocument();
  });
});
