import { renderHook, act, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ConfirmProvider } from '../ui/confirm.jsx';
import { useReschedule, patchPlanSchedule } from '../../lib/useReschedule.js';

// Feature 1: a date change reflects in the UI IMMEDIATELY (optimistic cache write),
// not only after the ['plans'] refetch round-trips. useReschedule must setQueryData
// before it awaits reschedulePost. We prove this with a reschedulePost that never
// resolves: the cache must already show the new scheduledAt while the call is in
// flight.

// A deferred (never-auto-resolving) reschedulePost so we can observe the cache
// state DURING the in-flight request.
let deferred;
vi.mock('../../lib/api.js', () => ({
  reschedulePost: (...args) => {
    deferred.calls.push(args);
    return deferred.promise;
  },
}));

const PLANS = {
  campaigns: [
    { id: 'acme', posts: [
      { id: 'p1', campaign: 'acme', scheduledAt: '2026-06-16T09:00:00.000Z' },
      { id: 'p2', campaign: 'acme', scheduledAt: '2026-06-17T09:00:00.000Z' },
    ] },
  ],
};

const findPost = (plans, id) => plans.campaigns[0].posts.find((p) => p.id === id);

function setup() {
  const client = new QueryClient();
  client.setQueryData(['plans'], PLANS);
  const wrapper = ({ children }) => (
    <QueryClientProvider client={client}>
      <ConfirmProvider>{children}</ConfirmProvider>
    </QueryClientProvider>
  );
  const { result } = renderHook(() => useReschedule(), { wrapper });
  return { client, reschedule: result.current };
}

beforeEach(() => {
  deferred = { calls: [], promise: new Promise(() => {}) };
});

describe('patchPlanSchedule (pure helper)', () => {
  it('immutably replaces the matching post scheduledAt, leaving siblings untouched', () => {
    const next = patchPlanSchedule(PLANS, 'acme', 'p1', '2026-06-20T09:00:00.000Z');
    expect(findPost(next, 'p1').scheduledAt).toBe('2026-06-20T09:00:00.000Z');
    expect(findPost(next, 'p2').scheduledAt).toBe('2026-06-17T09:00:00.000Z'); // untouched
    expect(next).not.toBe(PLANS); // new object
    expect(findPost(PLANS, 'p1').scheduledAt).toBe('2026-06-16T09:00:00.000Z'); // original not mutated
  });

  it('is a no-op when the post or plans are missing', () => {
    expect(patchPlanSchedule(PLANS, 'acme', 'nope', 'x')).toEqual(PLANS);
    expect(patchPlanSchedule(undefined, 'acme', 'p1', 'x')).toBe(undefined);
    expect(patchPlanSchedule({}, 'acme', 'p1', 'x')).toEqual({});
  });
});

describe('useReschedule optimistic update', () => {
  it('moves the post in the ["plans"] cache immediately, before reschedulePost resolves', () => {
    const { client, reschedule } = setup();
    // Fire the reschedule but DO NOT resolve the deferred network promise.
    act(() => { reschedule({ campaign: 'acme', id: 'p1' }, '2026-06-25T09:00:00.000Z'); });
    // The API was called (request in flight)...
    expect(deferred.calls.length).toBe(1);
    // ...and the cache ALREADY reflects the new day, with no refetch resolved.
    const cached = client.getQueryData(['plans']);
    expect(findPost(cached, 'p1').scheduledAt).toBe('2026-06-25T09:00:00.000Z');
    expect(findPost(cached, 'p2').scheduledAt).toBe('2026-06-17T09:00:00.000Z');
  });
});

// Wave 2g F7 (found by the no-raw-error-inline guard): the reschedule dialogs used the
// server's English line as their body. Both now say the Studio's own sentence; a timeout or
// an offline pendpost still gets its known sentence.
describe('useReschedule dialogs never show the raw server line', () => {
  it('a failed move says the plain sentence, not "HTTP 500 internal"', async () => {
    deferred.promise = Promise.reject(new Error('HTTP 500 internal'));
    const { reschedule } = setup();
    act(() => { reschedule({ campaign: 'acme', id: 'p1' }, '2026-06-25T09:00:00.000Z'); });
    expect(await screen.findByText('The post could not be rescheduled.')).toBeInTheDocument();
    expect(screen.queryByText(/HTTP 500/)).toBeNull();
  });

  it('a failed move with pendpost offline says so', async () => {
    deferred.promise = Promise.reject(new TypeError('Load failed'));
    const { reschedule } = setup();
    act(() => { reschedule({ campaign: 'acme', id: 'p1' }, '2026-06-25T09:00:00.000Z'); });
    expect(await screen.findByText('Could not reach your local pendpost. Is it running?')).toBeInTheDocument();
  });

  it('the native-handoff confirm says the Studio sentence, not the server line', async () => {
    deferred.promise = Promise.reject(Object.assign(new Error('needs_confirm: pass confirm:true to recreate the native object'), { code: 'needs_confirm' }));
    const { reschedule } = setup();
    act(() => { reschedule({ campaign: 'acme', id: 'p1' }, '2026-06-25T09:00:00.000Z'); });
    expect(await screen.findByText(/Rescheduling deletes the scheduled object/)).toBeInTheDocument();
    expect(screen.queryByText(/pass confirm:true/)).toBeNull();
  });
});
