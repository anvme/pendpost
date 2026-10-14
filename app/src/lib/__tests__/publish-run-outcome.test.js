import { describe, it, expect } from 'vitest';
import { publishRunOutcome } from '../format.js';

// publishRunOutcome reads the server's per-run `ran` rows as the per-post truth. Two
// informational marker codes are NOT failures: `cloud_held` (the cloud owns the lane
// inside its handoff grace) and `lane_halted` (an account-level breaker, e.g. X 402
// credits, dropped the lane before dispatch). Both must surface as their own flag so the
// run-now UIs point at the right recovery instead of the "not due / scheduler race" lie,
// and neither may become `failure` (which is reserved for a genuine per-lane failure).
// Wave 2g F6: `failure` is the failing row in the post.lastFailure shape ({ lane, message,
// code }) that humanizeFailure reads, so every caller says it through the one mapper and none
// re-derives the row. The raw engine text is never handed back as a ready-made `reason`.

const row = (over) => ({ campaign: 'c', postId: 'p1', lane: 'x', ok: false, ...over });

describe('publishRunOutcome', () => {
  it('fired when any row for the post succeeded', () => {
    const out = publishRunOutcome({ ran: [row({ ok: true })] }, 'p1');
    expect(out).toMatchObject({ fired: true, held: false, halted: false, cloudWait: false, failure: null });
  });

  it('halted (not failed) when the only row is a lane_halted marker', () => {
    const out = publishRunOutcome({ ran: [row({ errorCode: 'lane_halted', errorMessage: 'x lane is paused (credits)' })] }, 'p1');
    expect(out.fired).toBe(false);
    expect(out.halted).toBe(true);
    expect(out.held).toBe(false);
    // the marker never becomes a `failure`: the UI shows the resume copy, not this string
    expect(out.failure).toBe(null);
  });

  it('held for a cloud_held marker, distinct from halted', () => {
    const out = publishRunOutcome({ ran: [row({ errorCode: 'cloud_held' })] }, 'p1');
    expect(out).toMatchObject({ fired: false, held: true, halted: false });
  });

  it('cloudWait for a cloud_claim_wait marker: not held (no 20-minute promise), not a failure', () => {
    // The fail-closed backstop hold: the cloud HAS this post and cannot answer the publish
    // claim. Its own flag, because the cloud_held copy ("the local backstop steps in within
    // 20 minutes") is false here: nothing goes out locally until the cloud answers.
    const out = publishRunOutcome({ ran: [row({ lane: 'meta', errorCode: 'cloud_claim_wait', errorMessage: 'the cloud already has this post' })] }, 'p1');
    expect(out).toMatchObject({ fired: false, held: false, halted: false, cloudWait: true, failure: null });
  });

  it('a genuine per-lane failure still surfaces as the failing row, even alongside a marker', () => {
    const out = publishRunOutcome({ ran: [
      row({ errorCode: 'lane_halted', errorMessage: 'x paused' }),
      row({ lane: 'linkedin', errorCode: 'engine_failure', errorMessage: 'boom' }),
    ] }, 'p1');
    expect(out.halted).toBe(true);
    expect(out.failure).toEqual({ lane: 'linkedin', message: 'boom', code: 'engine_failure' });
    expect(out).not.toHaveProperty('reason');
  });

  it('empty ran for the post = nothing dispatched (no flags, no reason)', () => {
    const out = publishRunOutcome({ ran: [row({ postId: 'other', ok: true })] }, 'p1');
    expect(out).toMatchObject({ fired: false, held: false, halted: false, failure: null });
    expect(out.rows).toHaveLength(0);
  });

  it('a code-only failure keeps the code for the mapper, message null', () => {
    const out = publishRunOutcome({ ran: [row({ errorCode: 'auth_expired' })] }, 'p1');
    expect(out.failure).toEqual({ lane: 'x', message: null, code: 'auth_expired' });
  });
});
