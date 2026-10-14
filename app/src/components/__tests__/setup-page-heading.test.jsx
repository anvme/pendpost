import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import App from '../../App.jsx';
import { ConfirmProvider } from '../ui/confirm.jsx';

// D13: the app chrome already renders the page title as the one <h1> (App.jsx pageTitle), so
// the Setup page does not repeat it as its own <h2> (precedent: Settings.jsx). The page title
// appears exactly once as a heading; the subtitle, which carries information, stays.
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
    useConfig: () => ({ data: undefined, isLoading: true }),
    useSignals: () => ({ data: undefined, isLoading: false }),
  };
});

beforeEach(() => {
  window.location.hash = '#setup';
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

describe('Setup page heading (D13)', () => {
  it('the page title is one heading (the chrome h1), never repeated by the page', () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <ConfirmProvider>
          <App />
        </ConfirmProvider>
      </QueryClientProvider>,
    );
    const titles = screen.getAllByRole('heading', { name: /^(Einrichtung|Setup)$/ });
    expect(titles).toHaveLength(1);
    expect(titles[0].tagName).toBe('H1');
    // The subtitle carries information (where secrets live), so it stays.
    expect(screen.getByText(/(Geheimnisse|secrets)/)).toBeInTheDocument();
  });
});
