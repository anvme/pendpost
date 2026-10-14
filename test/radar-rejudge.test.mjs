// radar-rejudge.test.mjs - ops/radar-rejudge.mjs, the one-off backlog purge (relevance plan
// 2026-09-30, Phase 1b).
//
// Proofs:
//   (a) it refuses without an explicit --client, and for a client that does not exist;
//   (b) a dry run (the default) reports per reason and writes NOTHING;
//   (c) --apply refuses while a daemon answers on the port (it would overwrite the write);
//   (d) --apply with no daemon moves the drops to state.radar.seen (reason, by:'rejudge'), gives
//       the judge's keeps their score and reason, leaves agent-found and pinned signals alone, and
//       writes a backup first.
//
// HERMETIC: a temp PENDPOST_ROOT with one client, a fake judge via PENDPOST_AGENT_BIN_CLAUDE_CODE,
// and a free port for the daemon probe. The script runs as a child process, exactly as an operator
// runs it.
import assert from 'node:assert';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

let pass = 0;
let failures = 0;
function ok(cond, msg) {
  if (cond) { pass += 1; console.log(`  ok - ${msg}`); } else { failures += 1; console.error(`  FAIL - ${msg}`); }
}

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(REPO, 'ops', 'radar-rejudge.mjs');
const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-radar-rejudge-'));
const CLIENT = path.join(WS, 'data', 'clients', 'acme');
fs.mkdirSync(CLIENT, { recursive: true });
fs.writeFileSync(path.join(CLIENT, '.env'), 'CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-fake\n');

const judgeBin = path.join(WS, 'judge-claude');
fs.writeFileSync(judgeBin, `#!/usr/bin/env node
const args = process.argv.slice(2);
const prompt = args[args.indexOf('-p') + 1] || '';
const items = prompt.split('\\n').filter((l) => l.startsWith('{"id":"c')).map((l) => JSON.parse(l));
const verdicts = items.map((i) => /which/.test(i.text)
  ? { id: i.id, keep: true, score: 81, reason: 'asks which tool to use', reasonCode: null }
  : { id: i.id, keep: false, score: 3, reason: 'a happy user', reasonCode: 'not-a-seeker' });
process.stdout.write(JSON.stringify({ type: 'result', is_error: false, result: JSON.stringify({ verdicts }) }));
`);
fs.chmodSync(judgeBin, 0o755);

const nowIso = new Date().toISOString();
const sig = (id, text, extra = {}) => ({ source: 'mastodon', externalId: id, url: `https://m.example/@u/${id}`, author: `u_${id}`, text, matchedQuery: 'sched', community: null, ts: nowIso, intentScore: 40, intentTags: [], suggestedAction: 'watch', scoredBy: 'engine', scorerVersion: 2, ...extra });
const Q = { id: 'sched', label: 'scheduler seekers', keywords: ['social media scheduler'], sources: ['mastodon'] };
const seed = {
  radar: {
    seen: [],
    signals: [
      sig('lead', 'which social media scheduler handles Mastodon and Bluesky?'),
      sig('happy', 'my social media scheduler just posted the whole week for me, love it'),
      sig('relay', 'social media scheduler market report 2026', { author: 'news@flipboard.social' }),
      sig('scattered', 'The social contract is broken, a media outlet said so, and nobody agrees on anything anymore.'),
      sig('agent', 'an agent-found thread about a social media scheduler', { scoredBy: 'agent', ingested: true }),
      sig('pinned', 'loving this social media scheduler, pinned by the owner', { watched: true }),
    ],
  },
};
fs.writeFileSync(path.join(CLIENT, 'config.json'), JSON.stringify({ radar: { enabled: true, queries: [Q], agent: { provider: 'claude-code' } } }));
fs.writeFileSync(path.join(CLIENT, 'state.json'), JSON.stringify(seed));

// A port nothing listens on, for the "no daemon" runs.
const freePort = await new Promise((resolve) => { const s = http.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
// Async on purpose: the fake daemon below lives in THIS process, and a spawnSync would block the
// very event loop that has to answer the script's probe.
const run = (args, port = freePort) => new Promise((resolve) => {
  const child = spawn(process.execPath, [SCRIPT, ...args], {
    cwd: REPO,
    env: { ...process.env, PENDPOST_ROOT: WS, PENDPOST_MODE: 'mock', PENDPOST_PORT: String(port), PENDPOST_AGENT_BIN_CLAUDE_CODE: judgeBin },
  });
  let stdout = ''; let stderr = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });
  const timer = setTimeout(() => child.kill('SIGKILL'), 60_000);
  child.on('close', (status) => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
});
const readState = () => JSON.parse(fs.readFileSync(path.join(CLIENT, 'state.json'), 'utf8'));

try {
  // (a) refusals.
  let r = await run([]);
  ok(r.status === 2 && /--client <id> is required/.test(r.stderr), `no --client -> refused, exit 2 (${r.status})`);
  r = await run(['--client', 'nobody']);
  ok(r.status === 2 && /no client 'nobody'/.test(r.stderr), 'an unknown client -> refused');
  r = await run(['--client', '../acme']);
  ok(r.status === 2 && /refusing/.test(r.stderr), 'a path-like client id -> refused');

  // (b) dry run.
  const before = fs.readFileSync(path.join(CLIENT, 'state.json'), 'utf8');
  r = await run(['--client', 'acme', '--json']);
  ok(r.status === 0, `a dry run exits 0 (${r.status} ${r.stderr.slice(0, 200)})`);
  const rep = JSON.parse(r.stdout.trim().split('\n').pop());
  ok(rep.mode === 'dry-run' && rep.examined === 4, `the dry run examines only undecided engine signals (examined ${rep.examined}: not agent-found, not pinned)`);
  ok(rep.prefilter.relay === 1 && rep.prefilter.noAnchor === 1, `pre-filter reasons are reported (${JSON.stringify(rep.prefilter)})`);
  ok(rep.judge.ran === true && rep.judge.kept === 1 && rep.judge.dropped === 1 && rep.judge.byReason['not-a-seeker'] === 1, `judge reasons are reported (${JSON.stringify(rep.judge)})`);
  ok(rep.removed === 3, `the dry run would remove 3 (${rep.removed})`);
  ok(fs.readFileSync(path.join(CLIENT, 'state.json'), 'utf8') === before, 'a dry run writes NOTHING');
  r = await run(['--client', 'acme']);
  ok(r.status === 0 && /pre-filter drops:/.test(r.stdout) && /dry run: nothing was written/.test(r.stdout), 'the human report names the reasons and says nothing was written');
  r = await run(['--client', 'acme', '--no-judge', '--json']);
  const noJudge = JSON.parse(r.stdout.trim().split('\n').pop());
  ok(noJudge.judge.ran === false && noJudge.removed === 2, '--no-judge runs the free pre-filters only');

  // (c) --apply refuses while a daemon answers.
  const daemon = http.createServer((req, res) => { res.writeHead(200); res.end('ok'); });
  await new Promise((resolve) => daemon.listen(0, '127.0.0.1', resolve));
  r = await run(['--client', 'acme', '--apply'], daemon.address().port);
  await new Promise((resolve) => daemon.close(resolve));
  ok(r.status === 3 && /daemon answers/.test(r.stderr), `--apply refuses while the daemon is up (exit ${r.status})`);
  ok(fs.readFileSync(path.join(CLIENT, 'state.json'), 'utf8') === before, 'the refused apply wrote nothing');

  // (d) --apply for real.
  r = await run(['--client', 'acme', '--apply', '--json']);
  ok(r.status === 0, `--apply exits 0 (${r.status} ${r.stderr.slice(0, 200)})`);
  const applied = JSON.parse(r.stdout.trim().split('\n').pop());
  ok(applied.applied === true && applied.backup && fs.existsSync(applied.backup), 'a backup of state.json is written before the save');
  const st = readState();
  const ids = st.radar.signals.map((s) => s.externalId).sort();
  ok(ids.join(',') === 'agent,lead,pinned', `drops leave the feed; agent-found and pinned stay (${ids.join(',')})`);
  const seen = Object.fromEntries(st.radar.seen.map((e) => [e.externalId, e]));
  ok(seen.happy && seen.happy.reason === 'not-a-seeker' && seen.happy.by === 'rejudge' && seen.relay.reason === 'relay' && seen.scattered.reason === 'noAnchor', 'every drop is in state.radar.seen with its reason');
  const lead = st.radar.signals.find((s) => s.externalId === 'lead');
  ok(lead.judged === true && lead.intentScore === 81 && lead.scoredBy === 'agent' && lead.reason === 'asks which tool to use' && !('scorerVersion' in lead), 'a keep takes the judge score and reason');
  // Idempotent: a second apply finds nothing left to decide.
  r = await run(['--client', 'acme', '--apply', '--json']);
  const again = JSON.parse(r.stdout.trim().split('\n').pop());
  ok(again.examined === 0 && again.removed === 0, 'a second run finds nothing left to decide');
} catch (err) {
  failures += 1;
  console.error('  FAIL - threw:', err && err.stack ? err.stack : err);
}

try { fs.rmSync(WS, { recursive: true, force: true }); } catch { /* best effort */ }
if (failures) {
  console.error(`[radar-rejudge] FAIL - ${failures} assertion(s) failed, ${pass} passed`);
  assert.fail(`${failures} assertion(s) failed`);
}
console.log(`[radar-rejudge] OK - the backlog purge refuses without a client, dry-runs by default and applies safely (${pass} assertions).`);
