import { render, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import App from '../../App.jsx';
import { ConfirmProvider } from '../ui/confirm.jsx';

// HARD owner rule, the app-shell scroll model: the shell is a fixed-height frame (the window
// never scrolls), the sidebar is a static rail, and the WHOLE right column <main> is the ONE
// vertical scroller, so the header and toolbar travel WITH the content. "Only the inner planner
// container scrolls while the header stays fixed" is the rejected alternative (a cramped inner
// box). 45c4e0f2 (2026-08-20) brought that box back by making the content panel
// `flex-1 min-h-0 overflow-auto`; these tests pin the model on every page. The real geometry
// (header leaves the viewport, no inner element overflows vertically) is measured in the
// browser flow verify-shell-scroll.cjs.
const POST = {
  campaign: 'launch', id: 'p1', approval: 'pending', derivedState: 'draft', scheduledAt: '2026-09-28T10:00:00Z',
  type: 'image', platforms: ['mastodon'], media: { file: null, exists: false }, caption: 'Hello', title: 'Hello',
};

vi.mock('../../lib/api.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    useActivity: () => ({ data: { activity: [] }, isLoading: false, isError: false }),
    // One pending post, so Freigaben renders its list and the planner its grid.
    usePlans: () => ({ data: { campaigns: [{ id: 'launch', active: true, posts: [POST] }] }, isLoading: false, isError: false }),
    useAccounts: () => ({ data: {} }),
    useActiveClient: () => ({ activeClient: null, data: { clients: [], activeClientId: null }, isLoading: false, isError: false, activeClientId: null }),
    useClients: () => ({ data: { clients: [], activeClientId: null }, isLoading: false, isError: false, error: null }),
    usePendpostHealth: () => ({ data: null, isLoading: false, isError: false }),
  };
});

beforeEach(() => {
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
afterEach(() => { cleanup(); window.location.hash = ''; });

function renderApp(hash) {
  window.location.hash = hash ? `#${hash}` : '';
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ConfirmProvider>
        <App />
      </ConfirmProvider>
    </QueryClientProvider>,
  );
}

const has = (el, token) => (el.getAttribute('class') || '').split(/\s+/).includes(token);
// A class that makes an element a VERTICAL scroll container. `overflow-x-auto` also computes
// overflow-y to auto, so it only counts when something also caps the height.
const VERTICAL = ['overflow-auto', 'overflow-y-auto', 'overflow-scroll', 'overflow-y-scroll'];
const HEIGHT_CAP = /(^|\s)(min-h-0|flex-1|h-full|h-screen|h-dvh|max-h-\S+|h-\[\S+\])(\s|$)/;

const PAGES = ['planner', 'freigaben', 'activity', 'published', 'insights', 'radar', 'assets', 'setup', 'settings', 'clients', 'cloud'];

describe('app shell scroll model: <main> is the one vertical scroller', () => {
  it('the shell is a fixed-height frame and <main> is the scroller; the header lives inside it', () => {
    renderApp('planner');
    const main = document.querySelector('main');
    expect(main).not.toBeNull();
    expect(has(main, 'overflow-y-auto')).toBe(true);
    expect(has(main, 'min-h-0')).toBe(true);
    const frame = main.parentElement;
    expect(has(frame, 'h-dvh')).toBe(true);
    expect(has(frame, 'overflow-hidden')).toBe(true);
    // The header travels WITH the content: it is a child of the scroller, not a sibling.
    const header = document.querySelector('header');
    expect(main.contains(header)).toBe(true);
  });

  // final-a7: the sidebar is a separate fixed rail beside <main>, not part of the page. At lg+ it
  // used to reset to overflow-visible, so at 1280x600 its bottom rows (Hilfe & Feedback at y 707)
  // ran past the h-dvh overflow-hidden frame, clipped and unreachable. The rail keeps its own
  // overflow-y-auto at every width: it scrolls only when its content is taller than the window
  // (measured in verify-shell-scroll.cjs R1), and it is a sibling of <main>, never nested in it.
  it('the sidebar rail scrolls itself at every width when its content is taller than the window', () => {
    renderApp('planner');
    const aside = document.querySelector('aside#app-sidebar');
    expect(aside).not.toBeNull();
    expect(has(aside, 'overflow-y-auto')).toBe(true);
    expect((aside.getAttribute('class') || '').split(/\s+/).filter((c) => /^lg:overflow/.test(c))).toEqual([]);
    const main = document.querySelector('main');
    expect(main.contains(aside)).toBe(false);
    expect(aside.parentElement).toBe(main.parentElement);
  });

  it('the content panel grows with its content (never a capped inner scroll box)', () => {
    renderApp('planner');
    const main = document.querySelector('main');
    const panel = [...main.children].at(-1);
    expect(has(panel, 'glass-panel')).toBe(true);
    for (const t of [...VERTICAL, 'overflow-x-auto', 'min-h-0']) expect(has(panel, t), t).toBe(false);
    expect(has(panel, 'shrink-0')).toBe(true);
  });

  for (const page of PAGES) {
    it(`${page}: nothing inside <main> is its own vertical scroller`, () => {
      renderApp(page);
      const main = document.querySelector('main');
      const offenders = [...main.querySelectorAll('*')].filter((el) => {
        if (VERTICAL.some((t) => has(el, t))) return true;
        return has(el, 'overflow-x-auto') && HEIGHT_CAP.test(el.getAttribute('class') || '');
      }).map((el) => `<${el.tagName.toLowerCase()} class="${el.getAttribute('class')}">`);
      expect(offenders).toEqual([]);
    });
  }

  it('freigaben: the sticky bulk bar and the list have no scrolling ancestor below <main>', () => {
    renderApp('freigaben');
    const main = document.querySelector('main');
    const list = main.querySelector('ul[role="list"]');
    expect(list).not.toBeNull();
    for (let el = list; el && el !== main; el = el.parentElement) {
      for (const t of [...VERTICAL, 'overflow-x-auto', 'overflow-hidden']) expect(has(el, t), `${t} on ${el.className}`).toBe(false);
    }
  });

  it('planner week: only the wide week grid scrolls sideways, in its own wrapper', () => {
    renderApp('planner');
    const main = document.querySelector('main');
    const grid = main.querySelector('.grid-cols-7');
    expect(grid).not.toBeNull();
    const wrap = grid.closest('.overflow-x-auto');
    expect(wrap).not.toBeNull();
    expect(HEIGHT_CAP.test(wrap.getAttribute('class'))).toBe(false);
  });
});
