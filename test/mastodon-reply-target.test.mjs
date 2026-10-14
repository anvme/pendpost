// Which status id a Mastodon Radar reply fires at ON THE HOME INSTANCE. externalId is a
// home-instance id only for engine-search signals; agent-found signals carry the author-instance
// id (or a sha256 fallback), which on the home instance 404s or threads under a stranger's post
// (2026-09-30). Those must resolve the canonical url on the home instance first.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mastodonReplyTarget } from '../lib/radar.mjs';

const HOME = 'https://mastodon.social';

test('engine-search signal (id differs from url id) replies to externalId without a lookup', async () => {
  const rr = { externalId: '109', url: 'https://westmichigan.social/@chris/116' };
  assert.deepEqual(await mastodonReplyTarget(rr, HOME, async () => { throw new Error('no lookup'); }), { id: '109' });
});

test('parentExternalId wins (captured on the home instance by author-reply detection)', async () => {
  assert.deepEqual(await mastodonReplyTarget({ parentExternalId: '7', externalId: '1', url: 'https://a/@b/1' }, HOME, null), { id: '7' });
});

test('a post already on the home instance replies to externalId without a lookup', async () => {
  const rr = { externalId: '111', url: 'https://mastodon.social/@chris/111' };
  assert.deepEqual(await mastodonReplyTarget(rr, HOME, async () => { throw new Error('no lookup'); }), { id: '111' });
});

test('agent-found signal resolves the canonical url on the home instance', async () => {
  const rr = { externalId: '116087731312452262', url: 'https://infosec.exchange/@solomonneas/116087731312452262' };
  const lookup = async (u) => { assert.equal(u, rr.url); return '555'; };
  assert.deepEqual(await mastodonReplyTarget(rr, HOME, lookup), { id: '555' });
});

test('unresolvable url is target-gone, never a guess', async () => {
  const rr = { externalId: 'f'.repeat(64), url: 'https://gone.example/@x/1' };
  assert.deepEqual(await mastodonReplyTarget(rr, HOME, async () => null), { id: null, gone: true });
});

test('a failed lookup (instance unreachable, 5xx) propagates, never a terminal target-gone', async () => {
  const rr = { externalId: '116087731312452262', url: 'https://infosec.exchange/@solomonneas/116087731312452262' };
  await assert.rejects(mastodonReplyTarget(rr, HOME, async () => { throw new Error('mastodon search HTTP 503'); }), /HTTP 503/);
});

test('resolveMastodonStatusId throws on a non-ok search, returns null only on an empty result', async () => {
  const { resolveMastodonStatusId } = await import('../lib/radar.mjs');
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response('{}', { status: 503, headers: { 'content-type': 'application/json' } });
    await assert.rejects(resolveMastodonStatusId(HOME, 't', 'https://a.example/@b/1'), /503/);
    globalThis.fetch = async () => new Response('{"statuses":[]}', { status: 200, headers: { 'content-type': 'application/json' } });
    assert.equal(await resolveMastodonStatusId(HOME, 't', 'https://a.example/@b/1'), null);
    globalThis.fetch = async () => new Response('{"statuses":[{"id":"42"}]}', { status: 200, headers: { 'content-type': 'application/json' } });
    assert.equal(await resolveMastodonStatusId(HOME, 't', 'https://a.example/@b/1'), '42');
  } finally {
    globalThis.fetch = realFetch;
  }
});
