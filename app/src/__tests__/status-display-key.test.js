import { describe, it, expect } from 'vitest';
import en from '../locales/en.json';
import deCH from '../locales/de-CH.json';
import { postStatusKey, postDisplayStatusKey, postDisplayState, postStatusWord, STATUS_PILL_META, ROW_STATUS_META, STATE_META, ATTENTION_WORDS } from '../lib/format.js';

// Regression guard for the verify-failed label drift: the planner card used to fold
// verify-failed into the red 'overdue' pill ("Überfällig") via postStatusKey, while
// the StatusPill on the detail/run-now surfaces rendered the derivedState directly
// ("Ungeprüft"). The same post then read two different things. The fix: keep the
// FILTER bucket on 'overdue' (needs attention) but give the VISIBLE bucket its own
// 'verify-failed' treatment via postDisplayStatusKey, and resolve ONE label for it.
const verifyFailed = { derivedState: 'verify-failed', approval: 'approved' };

describe('verify-failed status: one coherent label/treatment', () => {
  it('still FILTERS under overdue (needs-attention bucket unchanged)', () => {
    expect(postStatusKey(verifyFailed)).toBe('overdue');
  });

  it('DISPLAYS as its own verify-failed bucket, not the red overdue pill', () => {
    expect(postDisplayStatusKey(verifyFailed)).toBe('verify-failed');
  });

  it('every other state still displays exactly as it filters', () => {
    for (const post of [
      { derivedState: 'overdue', approval: 'approved' },
      { derivedState: 'posted', approval: 'approved' },
      { derivedState: 'parked', approval: 'approved' },
      { derivedState: 'waiting-due', approval: 'approved' },
      { approval: 'draft' },
    ]) {
      expect(postDisplayStatusKey(post)).toBe(postStatusKey(post));
    }
  });

  // Staircase: verify-failed and overdue now share the light-red HALTED stop (both are
  // stalled failures) - the tone no longer distinguishes them; the icon + label do
  // (AlertTriangle "Ungeprüft" vs OctagonX "Überfällig"). What must stay distinct is the
  // DEEP-red rejected terminus: a failure pendpost can retry is not a human rejection.
  it('carries the light-red halted tone, distinct from the deep-red rejected terminus', () => {
    const meta = STATUS_PILL_META['verify-failed'];
    expect(meta).toBeTruthy();
    expect(meta.cls).toMatch(/rose-400/);
    expect(meta.cls).not.toBe(STATUS_PILL_META.rejected.cls); // rejected = deep red
  });

  it('the calendar pill (status.verify-failed) carries the SAME label as the StatusPill (state.short.verify-failed) in both packs', () => {
    for (const pack of [en, deCH]) {
      expect(pack.strings['status.verify-failed']).toBe(pack.strings['state.short.verify-failed']);
    }
    // and it is NOT the misleading "overdue" wording the card showed before.
    expect(en.strings['status.verify-failed']).not.toBe(en.strings['status.overdue']);
  });

  it('keeps the verify-failed STATE_META icon and STATUS_PILL_META icon in step', () => {
    expect(STATUS_PILL_META['verify-failed'].Icon).toBe(STATE_META['verify-failed'].Icon);
  });
});

// A publish-failed post whose failure is NON-terminal (lastFailure.terminal === false) is
// one pendpost is auto-retrying after a transient platform hiccup (e.g. Instagram's
// intermittent rupload ProcessingFailedError). Showing the red "Failed" pill for a post
// the system is actively recovering is the exact mislabel this session started from. It
// must read as a calm "Retrying" instead, while still FILTERING as overdue (unchanged).
const retrying = { derivedState: 'publish-failed', approval: 'approved', lastFailure: { terminal: false } };
const terminalFail = { derivedState: 'publish-failed', approval: 'approved', lastFailure: { terminal: true } };

describe('publish-retrying: a non-terminal failure reads as Retrying, not Failed', () => {
  it('still FILTERS under overdue (needs-attention bucket unchanged)', () => {
    expect(postStatusKey(retrying)).toBe('overdue');
  });

  it('DISPLAYS as publish-retrying, not the red publish-failed pill', () => {
    expect(postDisplayStatusKey(retrying)).toBe('publish-retrying');
  });

  it('a TERMINAL failure still displays as publish-failed (red stays for parked/refused)', () => {
    expect(postDisplayStatusKey(terminalFail)).toBe('publish-failed');
  });

  it('postDisplayState (the two-axis StatusPill key) mirrors the same split', () => {
    expect(postDisplayState(retrying)).toBe('publish-retrying');
    expect(postDisplayState(terminalFail)).toBe('publish-failed');
  });

  it('carries the calm GREY working stop, NOT the red halted tone and NOT an attention accent', () => {
    const meta = STATUS_PILL_META['publish-retrying'];
    expect(meta).toBeTruthy();
    expect(meta.cls).not.toBe(STATUS_PILL_META['publish-failed'].cls); // not the light-red halted tone
    expect(meta.bar).toBe(''); // no left-edge alarm - the system is handling it
    expect(meta.strip).toBe('');
  });

  it('resolves ONE coherent label across the card (status.*) and StatusPill (state.short.*) in both packs', () => {
    for (const pack of [en, deCH]) {
      expect(pack.strings['status.publish-retrying']).toBe(pack.strings['state.short.publish-retrying']);
      expect(pack.strings['status.publish-retrying']).not.toBe(pack.strings['status.publish-failed']);
    }
  });

  it('keeps the publish-retrying STATE_META icon and STATUS_PILL_META icon in step', () => {
    expect(STATUS_PILL_META['publish-retrying'].Icon).toBe(STATE_META['publish-retrying'].Icon);
  });
});

// A HALTED failure (the lane is circuit-broken, e.g. X HTTP 402 credits depleted) is
// NOT being auto-retried - the scheduler drops the whole lane every tick until the
// operator tops up and resumes. So it must NOT be demoted to the calm "Retrying" pill
// (which promises an auto-retry that will never come); it keeps the honest red
// publish-failed pill, and the credits copy + top-up link in the failure box carry the
// real signal. This guards the exact lie this session started from.
const haltedNonTerminal = { derivedState: 'publish-failed', approval: 'approved', lastFailure: { terminal: false, halted: true, haltCode: 'credits' } };

describe('halted-credits: a lane-halt keeps the honest Failed pill, never Retrying', () => {
  it('DISPLAYS as publish-failed even though terminal is false (halted overrides the retry demotion)', () => {
    expect(postDisplayStatusKey(haltedNonTerminal)).toBe('publish-failed');
  });

  it('postDisplayState (the two-axis StatusPill key) keeps publish-failed, not publish-retrying', () => {
    expect(postDisplayState(haltedNonTerminal)).toBe('publish-failed');
  });

  it('still FILTERS under overdue (needs-attention bucket unchanged)', () => {
    expect(postStatusKey(haltedNonTerminal)).toBe('overdue');
  });

  it('a non-halted non-terminal failure is unaffected (still Retrying)', () => {
    expect(postDisplayStatusKey(retrying)).toBe('publish-retrying');
    expect(postDisplayState(retrying)).toBe('publish-retrying');
  });
});

// A failure no retry can fix carries lastFailure.recovery (lib/publish-hold.mjs
// failureRecovery, surfaced by lib/plans.mjs lastFailureFor): a cloud credential refusal
// ('reconnect'), X's reply restriction ('manual'), a content block ('edit'). It used to
// read "Wird wiederholt" (a credential refusal kept terminal:false) or a bare "Failed".
// It reads "waiting on you" on every surface instead, keyed off the engine's field only.
const needsReconnect = { derivedState: 'publish-failed', approval: 'approved', lastFailure: { terminal: true, recovery: 'reconnect', lane: 'linkedin' } };
const needsReconnectLegacy = { derivedState: 'publish-failed', approval: 'approved', lastFailure: { terminal: false, recovery: 'reconnect', lane: 'linkedin' } };

describe('publish-needs-you: a failure only the operator can recover never reads as Retrying', () => {
  it('DISPLAYS as publish-needs-you on the card and the StatusPill, for every recovery', () => {
    for (const recovery of ['reconnect', 'manual', 'edit']) {
      const p = { ...needsReconnect, lastFailure: { ...needsReconnect.lastFailure, recovery } };
      expect(postDisplayStatusKey(p)).toBe('publish-needs-you');
      expect(postDisplayState(p)).toBe('publish-needs-you');
    }
  });

  it('the recovery wins even when terminal is false (never "Wird wiederholt")', () => {
    expect(postDisplayStatusKey(needsReconnectLegacy)).toBe('publish-needs-you');
    expect(postDisplayState(needsReconnectLegacy)).toBe('publish-needs-you');
  });

  it('a LOCAL credential failure (needs_scope on the first attempt) waits on you too', () => {
    // Reconnect-first: lib/publish-hold.mjs isCredentialFailure parks it on the first strike
    // and failureRecovery names the reconnect, so it never reads "Wird wiederholt".
    const p = { derivedState: 'publish-failed', approval: 'approved', publishHold: { lane: 'linkedin', code: 'needs_scope' }, lastFailure: { code: 'needs_scope', lane: 'linkedin', message: 'LinkedIn POST /rest/posts: HTTP 401 - EXPIRED_ACCESS_TOKEN', terminal: true, recovery: 'reconnect', halted: false } };
    expect(postDisplayStatusKey(p)).toBe('publish-needs-you');
    expect(postDisplayState(p)).toBe('publish-needs-you');
  });

  it('a lane halt keeps its own Failed pill (its recovery is the resume in the banner)', () => {
    const p = { ...needsReconnect, lastFailure: { ...needsReconnect.lastFailure, halted: true } };
    expect(postDisplayStatusKey(p)).toBe('publish-failed');
  });

  it('still FILTERS under overdue (needs-attention bucket unchanged)', () => {
    expect(postStatusKey(needsReconnect)).toBe('overdue');
  });

  it('wears the halted attention tone with an accent, and its icons stay in step', () => {
    const meta = STATUS_PILL_META['publish-needs-you'];
    expect(meta.cls).toBe(STATUS_PILL_META['publish-failed'].cls);
    expect(meta.bar).toBeTruthy();
    expect(meta.Icon).toBe(STATE_META['publish-needs-you'].Icon);
  });

  it('resolves ONE label across the card and the StatusPill in both packs', () => {
    for (const pack of [en, deCH]) {
      expect(pack.strings['status.publish-needs-you']).toBeTruthy();
      expect(pack.strings['status.publish-needs-you']).toBe(pack.strings['state.short.publish-needs-you']);
    }
    expect(deCH.strings['status.publish-needs-you']).toBe('Wartet auf dich');
  });
});

// One post, ONE status word (judge round 2): the planner card read "Freigegeben", the
// detail pill "Geplant", and the delivery row "Blockiert: Telegram verbinden" for the same
// approved Telegram post whose lane is not connected. postStatusWord is the single source
// the card, the list row AND the detail header render, so the three can never disagree.
describe('postStatusWord: one word for a post on every surface', () => {
  const setup = { platforms: [
    { platform: 'telegram', status: 'incomplete' },
    { platform: 'linkedin', status: 'connected', validation: { state: 'live' } },
  ] };
  const approvedTg = { derivedState: 'waiting-due', approval: 'approved', platforms: ['telegram'], scheduledAt: '2026-09-27T18:22:00Z' };

  it('a lane that is not connected reads "blocked", the delivery row word', () => {
    expect(postStatusWord(approvedTg, setup)).toBe('blocked');
    expect(postStatusWord({ ...approvedTg, approval: 'pending' }, setup)).toBe('blocked');
    expect(postStatusWord({ ...approvedTg, approval: 'draft' }, setup)).toBe('blocked');
  });

  it('without a setup payload (or with the lane connected) it keeps the approval word', () => {
    expect(postStatusWord(approvedTg)).toBe('approved');
    expect(postStatusWord({ ...approvedTg, platforms: ['linkedin'] }, setup)).toBe('approved');
  });

  it('a failure, an overdue, a posted, a parked or a rejected post keeps its own word over the lane block', () => {
    expect(postStatusWord({ ...approvedTg, derivedState: 'overdue' }, setup)).toBe('overdue');
    expect(postStatusWord({ ...approvedTg, derivedState: 'posted' }, setup)).toBe('posted');
    expect(postStatusWord({ ...approvedTg, derivedState: 'parked' }, setup)).toBe('parked');
    expect(postStatusWord({ ...approvedTg, approval: 'rejected' }, setup)).toBe('rejected');
    expect(postStatusWord({ ...approvedTg, derivedState: 'publish-failed', lastFailure: { terminal: true, recovery: 'reconnect' } }, setup)).toBe('publish-needs-you');
  });

  it('an approved post edited since approval reads "re-approve", never the green "approved"', () => {
    expect(postStatusWord({ ...approvedTg, platforms: ['linkedin'], editedSinceApproval: true }, setup)).toBe('edited');
  });

  it('a handed-off post reads "probable" on the card too, not "approved"', () => {
    expect(postStatusWord({ ...approvedTg, platforms: ['linkedin'], derivedState: 'fired-assumed' }, setup)).toBe('fired-assumed');
  });

  it('every word has pill META (tone + icon) and a status.<key> label in both packs', () => {
    for (const key of ['approved', 'edited', 'blocked', 'postYourself', 'fired-assumed', 'scheduled', 'draft', 'pending', 'rejected', 'overdue', 'posted', 'parked', 'verify-failed', 'publish-failed', 'publish-retrying', 'publish-needs-you']) {
      expect(ROW_STATUS_META[key], `ROW_STATUS_META.${key}`).toBeTruthy();
      expect(ROW_STATUS_META[key].Icon, `ROW_STATUS_META.${key}.Icon`).toBeTruthy();
      for (const pack of [en, deCH]) expect(pack.strings[`status.${key}`], `status.${key}`).toBeTruthy();
    }
  });

  it('the new words reuse the copy the detail surfaces already speak (one word, not a synonym)', () => {
    for (const pack of [en, deCH]) {
      const s = pack.strings;
      expect(s['status.approved']).toBe(s['approval.approved']);
      expect(s['status.edited']).toBe(s['approval.editedSinceApproval']);
      expect(s['status.fired-assumed']).toBe(s['state.short.fired-assumed']);
      // The manual paste lane reads the queue's own hand-off word, not a synonym.
      expect(s['status.postYourself']).toBe(s['approval.postYourself']);
      // The delivery row names the lane after the SAME word: "Blockiert: Telegram verbinden".
      expect(s['postDetail.delivery.blocked'].startsWith(`${s['status.blocked']}: `)).toBe(true);
    }
    expect(deCH.strings['status.blocked']).toBe('Blockiert');
  });
});

// P4: a genuinely manual paste lane (MANUAL_LANES, today reddit) is not "blocked": posting
// it by hand IS its path, so it reads the queue's hand-off word on every surface. Only a
// lane that is meant to publish and is not connected reads "blocked".
describe('postStatusWord: manual paste lane vs blocked lane', () => {
  const setup = { platforms: [
    { platform: 'telegram', status: 'incomplete' },
    { platform: 'reddit', status: 'incomplete' },
  ] };
  const reddit = { derivedState: 'waiting-due', approval: 'approved', platforms: ['reddit'], scheduledAt: '2026-09-27T18:22:00Z' };

  it('the paste lane alone reads "postYourself", whatever the approval', () => {
    expect(postStatusWord(reddit, setup)).toBe('postYourself');
    expect(postStatusWord({ ...reddit, approval: 'pending' }, setup)).toBe('postYourself');
  });

  it('a blocked lane beside the paste lane reads "blocked"', () => {
    expect(postStatusWord({ ...reddit, platforms: ['reddit', 'telegram'] }, setup)).toBe('blocked');
  });

  it('both words ask the owner to act, so neither goes quiet on a phone row', () => {
    expect(ATTENTION_WORDS.has('blocked')).toBe(true);
    expect(ATTENTION_WORDS.has('postYourself')).toBe(true);
  });
  // Q4: a retrying post heals itself; pendpost is the next actor, not the owner. It may go
  // quiet on a phone row like the other settled words. Its failed and needs-you siblings stay.
  it('a self-healing retry is not an ask; the failed and needs-you words still are', () => {
    expect(postStatusWord(retrying)).toBe('publish-retrying');
    expect(ATTENTION_WORDS.has('publish-retrying')).toBe(false);
    expect(ATTENTION_WORDS.has('publish-failed')).toBe(true);
    expect(ATTENTION_WORDS.has('publish-needs-you')).toBe(true);
  });
});

// r5-b1: the Month chip wears the pill's own GLYPH for the post's word (ROW_STATUS_META Icon),
// so status is never colour-only. The two lane words sit side by side in a Month cell, so
// they must differ in shape, not only in amber vs sky.
describe('month glyph: every word has a glyph, and the lane words differ in shape', () => {
  it('every status word the pill can show carries an Icon', () => {
    for (const [key, meta] of Object.entries(ROW_STATUS_META)) expect(meta.Icon, key).toBeTruthy();
  });

  it('blocked and postYourself are told apart by glyph, not hue alone', () => {
    expect(ROW_STATUS_META.blocked.Icon).not.toBe(ROW_STATUS_META.postYourself.Icon);
  });
});

// r5-b2: the month view shows the pill's glyph, not a colour dot (r5-b1 removed postDot), so no
// status map carries a per-status `dot` colour any more. A dot coming back would be status by
// colour alone (canon Tier 2); this keeps the dead field from being reintroduced.
describe('no status map carries a per-status dot colour', () => {
  it('STATE_META, STATUS_PILL_META and ROW_STATUS_META have no `dot` field', () => {
    for (const [name, map] of Object.entries({ STATE_META, STATUS_PILL_META, ROW_STATUS_META })) {
      for (const [key, meta] of Object.entries(map)) expect('dot' in meta, `${name}.${key}.dot`).toBe(false);
    }
  });
});
