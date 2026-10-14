// CloudIssues - the shared pieces that turn one `sync.issues[]` row (GET /api/cloud, see
// lib/cloud-client.mjs cloudSyncStatus) into something the owner can read and act on:
// the plain message, a one-line label, and exactly ONE action. Used by the header
// popover (ConnectionStatus) and the per-project rows on the Cloud page, so both faces
// say the same thing and offer the same fix.
//
// The action per kind:
//   credential            -> "Reconnect"  (Setup, focused on that lane, in that project)
//   post / overdue        -> "Open post"  (the post detail, in that project)
//   unreachable/worker_stale -> "Check again" (refetch the status)
// The caller owns navigation (onAction(issue, 'reconnect' | 'open')) and the refetch
// (onRecheck), so this file holds no routing and no queries.
import { ArrowRight, RefreshCw } from 'lucide-react';
import { useT } from '../lib/i18n.js';
import { fmtRelative, fmtTime } from '../lib/format.js';
import { failureKey, humanizeFailure, laneLabel } from '../lib/failureCopy.js';
import { Button } from './ui/Button.jsx';
import { TAP_TARGET } from './ui/recipes.js';

export { laneLabel };

// Connectivity rows describe the cloud as a whole (one workspace), not one project.
export const CONNECTIVITY = new Set(['unreachable', 'worker_stale']);

// The ONE cloud state behind the header dot AND the Cloud page pill, so the two faces can
// never disagree (the page once read "Attention" beside a green header dot). A failed
// subscription read is unknown, and unknown must never render as fine: it lifts an
// otherwise green roll-up to amber with its own reason. Returns
// { state: 'red'|'amber'|'yellow'|'green'|null, reason }.
// yellow is only a self-resolving wait inside its grace (push_pending, or a flag_divergence
// pendpost is re-asserting), which renders neutral, so an unreadable subscription lifts it
// to amber as well. Past the grace the engine itself sends amber (push_stuck, a stuck flag).
export function cloudHealth(sync, subFailed = false) {
  const s = sync?.state || null;
  if (s === 'red' || s === 'amber') return { state: s, reason: sync.reason || null };
  if (subFailed) return { state: 'amber', reason: 'subscription_failed' };
  return { state: s, reason: sync?.reason || null };
}

// The dot colour per health state, for the header dot AND every project row (null = no dot).
// Waiting is not a warning: yellow (a self-resolving wait) is a neutral grey dot, while amber and red
// stay warm for states that need a look. The Cloud page pill follows the same split.
const HEALTH_DOT = { red: 'bg-red-500', amber: 'bg-amber-500', yellow: 'bg-zinc-400 dark:bg-zinc-500' };
export function healthDot(state) {
  return HEALTH_DOT[state] || null;
}

// The one action an issue offers, or null when it has nothing to act on.
export function issueAction(issue) {
  if (!issue) return null;
  if (issue.kind === 'credential') return issue.lane ? 'reconnect' : null;
  if (issue.kind === 'post' || issue.kind === 'overdue') return issue.campaign && issue.postId ? 'open' : null;
  if (CONNECTIVITY.has(issue.kind)) return 'recheck';
  return null;
}

// red = a post did not go out; amber = connectivity, the local backstop covers it.
export function issueDot(issue) {
  return CONNECTIVITY.has(issue?.kind) ? 'bg-amber-500' : 'bg-red-500';
}

// The plain sentence for an issue. Our own states (credential, overdue, connectivity) are
// localized; a platform failure goes through the shared failure humanizer (one sentence:
// what happened and why), because the raw "lane: POST /path: HTTP 500 - ..." string is
// for a tooltip, never the row. The credential sentence names the platform.
export function issueMessage(issue, t) {
  if (!issue) return '';
  if (issue.kind === 'credential') {
    const vars = { lane: laneLabel(issue.lane) || t('failure.platform') };
    const key = `connection.issue.msg.${issue.code}`;
    const s = t(key, vars);
    return s !== key ? s : t('connection.issue.msg.account_unresolved', vars);
  }
  if (issue.kind === 'overdue') return t('connection.issue.msg.overdue');
  if (CONNECTIVITY.has(issue.kind)) {
    const backstop = t(`connection.sync.reason.${issue.kind === 'unreachable' ? 'cloud_unreachable' : 'worker_stale'}`);
    // The humanized last error, when it says more than the headline ("Cloud unreachable")
    // already does: a plain network failure would only repeat it.
    const key = issue.kind === 'unreachable' ? failureKey({ message: issue.message }) : null;
    return key && key !== 'failure.network' ? `${t(key, { lane: t('failure.cloud') })} ${backstop}` : backstop;
  }
  return humanizeFailure(issue, t).text || t('connection.issue.msg.post');
}

// The row's headline: the post's title when there is one, else a short kind label.
export function issueLabel(issue, t) {
  return issue?.title || t(`connection.issue.kind.${issue?.kind}`);
}

// The single "Check again" control, shared by issue rows and the reason lines of states
// that have no issue row (push pending, subscription read failed). Small painted box,
// 44px hit area (TAP_TARGET).
export function RecheckButton({ onRecheck, className = '' }) {
  const t = useT();
  if (!onRecheck) return null;
  return (
    <Button size="sm" variant="subtle" className={`${TAP_TARGET} ${className}`} onClick={() => onRecheck()}>
      <RefreshCw size={12} aria-hidden="true" />
      {t('connection.issue.recheck')}
    </Button>
  );
}

// Exactly one action button for an issue (or nothing). Small, subtle: it sits inside a
// list row, the page's primary CTA stays the page's.
export function IssueActionButton({ issue, onAction, onRecheck, className = '' }) {
  const t = useT();
  const action = issueAction(issue);
  if (!action) return null;
  if (action === 'recheck') return <RecheckButton onRecheck={onRecheck ? () => onRecheck(issue) : null} className={className} />;
  if (!onAction) return null;
  return (
    <Button size="sm" variant="subtle" className={`${TAP_TARGET} ${className}`} onClick={() => onAction(issue, action)}>
      {action === 'reconnect' ? t('connection.issue.reconnect') : t('connection.issue.openPost')}
      <ArrowRight size={12} aria-hidden="true" />
    </Button>
  );
}

// Where + when for a row. A connectivity row gets an explicit clock time (a relative
// "2 minutes ago" beside "unreachable" read as a contradiction): "last reached HH:MM" for an
// unreachable cloud, "last active HH:MM" (the worker's last heartbeat) for a stale one, whose
// cloud still answers.
function issueWhere(issue, showProject, t) {
  if (CONNECTIVITY.has(issue.kind)) {
    if (!issue.lastOkAt) return '';
    return t(issue.kind === 'worker_stale' ? 'connection.issue.lastActive' : 'connection.issue.lastReached', { time: fmtTime(issue.lastOkAt) });
  }
  const when = issue.at ? fmtRelative(issue.at) : '';
  return [showProject ? issue.clientName : null, laneLabel(issue.lane), when].filter(Boolean).join(' · ');
}

// One issue as a compact list row: headline (one line), where + when, the plain
// message (raw platform text on hover), the terminal note, and the single action.
export function CloudIssueRow({ issue, showProject = false, onAction, onRecheck }) {
  const t = useT();
  const where = issueWhere(issue, showProject, t);
  const raw = issue.kind === 'post' && typeof issue.message === 'string' ? issue.message : undefined;
  return (
    <li className="space-y-1 rounded-xl bg-zinc-100/70 px-3 py-2 dark:bg-zinc-800/50">
      <p className="flex items-center gap-1.5 text-[11px] font-bold text-zinc-700 dark:text-zinc-200">
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${issueDot(issue)}`} aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate" title={issueLabel(issue, t)}>{issueLabel(issue, t)}</span>
      </p>
      {where ? <p className="truncate text-[11px] text-zinc-500 dark:text-zinc-400">{where}</p> : null}
      <p className="break-words text-[11px] leading-relaxed text-zinc-600 dark:text-zinc-300" title={raw}>{issueMessage(issue, t)}</p>
      {issue.terminal ? <p className="text-[11px] font-bold text-red-600 dark:text-red-400">{t('connection.issue.terminal')}</p> : null}
      <IssueActionButton issue={issue} onAction={onAction} onRecheck={onRecheck} className="mt-0.5" />
    </li>
  );
}
