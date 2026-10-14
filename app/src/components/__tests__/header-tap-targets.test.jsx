import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import App from '../../App.jsx';
import { ConfirmProvider } from '../ui/confirm.jsx';

// Judge final (evidence gap): the header icon buttons (menu, cloud status, language, theme)
// are painted 32x32 and had no 44px hit area. They get TAP_TARGET (an absolutely positioned,
// centred 44x44 ::after box) with NO change to the painted h-8 w-8 box. Two 44px boxes on
// 32px buttons only stay apart when the buttons sit at least 12px apart, so the status/
// language/theme cluster uses gap-3 (one Tailwind step = 4px). The real geometry (effective
// box + corner hit test) is measured in the browser flow verify-reconnect-first.cjs.
vi.mock('../../lib/api.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    useActivity: () => ({ data: { activity: [] }, isLoading: false, isError: false }),
    usePlans: () => ({ data: { campaigns: [] }, isLoading: false, isError: false }),
    useAccounts: () => ({ data: {} }),
    useActiveClient: () => ({ activeClient: null, data: { clients: [], activeClientId: null }, isLoading: false, isError: false, activeClientId: null }),
    useClients: () => ({ data: { clients: [], activeClientId: null }, isLoading: false, isError: false, error: null }),
    usePendpostHealth: () => ({ data: null, isLoading: false, isError: false }),
  };
});

beforeEach(() => {
  window.location.hash = '';
  if (typeof window.localStorage === 'undefined' || typeof window.localStorage.getItem !== 'function') {
    const store = new Map();
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: {
        getItem: (k) => (store.has(k) ? store.get(k) : null),
        setItem: (k, v) => store.set(k, String(v)),
        removeItem: (k) => store.delete(k),
        clear: () => store.clear(),
      },
    });
  }
});

function renderApp() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ConfirmProvider>
        <App />
      </ConfirmProvider>
    </QueryClientProvider>,
  );
}

const LABELS = [/^(Open menu|Menü öffnen)$/, /^(Delivery and 24\/7 status|Status von Zustellung und 24\/7-Betrieb)$/, /^(Switch to (English|German)|Auf (Englisch|Deutsch) wechseln)$/, /^(Switch to (dark|light) theme|Zum (dunklen|hellen) Design wechseln)$/];

describe('header icon buttons: 44px hit area, unchanged painted box', () => {
  it('menu, cloud status, language and theme each carry the 44x44 TAP_TARGET box and stay painted h-8 w-8', () => {
    renderApp();
    const header = document.querySelector('header');
    expect(header).not.toBeNull();
    for (const name of LABELS) {
      const btn = screen.getAllByRole('button', { name }).find((b) => header.contains(b));
      expect(btn, String(name)).toBeTruthy();
      const cls = btn.className;
      expect(cls, String(name)).toMatch(/(^|\s)after:h-11(\s|$)/);
      expect(cls, String(name)).toMatch(/(^|\s)after:min-w-11(\s|$)/);
      expect(cls, String(name)).toMatch(/(^|\s)after:absolute(\s|$)/);
      expect(cls, String(name)).toMatch(/(^|\s)h-8(\s|$)/);
      expect(cls, String(name)).toMatch(/(^|\s)w-8(\s|$)/);
    }
  });

  it('the status, language and theme buttons sit 12px apart, so their 44px boxes never overlap', () => {
    renderApp();
    const header = document.querySelector('header');
    const theme = screen.getAllByRole('button', { name: LABELS[3] }).find((b) => header.contains(b));
    const cloud = screen.getAllByRole('button', { name: LABELS[1] }).find((b) => header.contains(b));
    const cluster = theme.parentElement;
    expect(cluster.contains(cloud)).toBe(true);
    expect(cluster.className).toMatch(/(^|\s)gap-3(\s|$)/);
  });
});
