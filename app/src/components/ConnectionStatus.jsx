// ConnectionStatus - the merged delivery + always-on control. It replaces the
// dismissible SchedulerChip: a persistent, NON-dismissible symbol that sits flush
// with the language/theme toggles and folds two things into one click-popover:
//  1. the local "keep pendpost open" delivery status (off the real scheduler flag), and
//  2. the optional managed-cloud upsell (be online round-the-clock without keeping
//     your computer on).
// Anti-slop: a single brand accent, font-bold max, sentence case, lowercase
// "pendpost". The colour dot is never the only signal - the popover states the
// status in words and the button carries an aria-label. Colour is spent on attention
// only: an all-clear state (everything delivered, publishing locally) carries no dot.
// External links reuse the app's <a target="_blank"> pattern (Published/PostDetail);
// the in-app action routes to the Cloud page via onNavigate.
import { useState } from 'react';
import { Cloud as CloudIcon, Monitor, MonitorOff, ExternalLink, ArrowRight } from 'lucide-react';
import { useCloud, useCloudClients, useCloudSubscription } from '../lib/cloud.js';
import { useT } from '../lib/i18n.js';
import { Tip } from './ui/Tooltip.jsx';
import { Popover, PopoverTrigger, PopoverContent } from './ui/Popover.jsx';
import { TAP_TARGET } from './ui/recipes.js';
import { CloudIssueRow, RecheckButton, cloudHealth, healthDot, CONNECTIVITY } from './CloudIssues.jsx';

// How many issue rows the popover lists before folding the rest into "n more" (which
// opens the Cloud page, where every project shows its own).
const MAX_ISSUES = 3;

// The managed-offering page (/services) is live. ?from=app flips its managed CTA to
// "enable always-on" (the visitor already has the app set up). External links open in the
// system browser via the launcher's WKWebView navigation policy (launcher/PendpostApp.swift).
const SERVICES_URL = 'https://pendpost.com/services?from=app';

// The merged state -> the icon, the status-dot colour (null = no dot), and the status-line
// key. Two orthogonal signals: the GLYPH encodes the delivery channel (a cloud = managed
// 24/7 runtime; a monitor = your own computer), the DOT encodes attention. The cloud state
// comes from cloudHealth (CloudIssues.jsx) - the SAME derivation the Cloud page pill reads,
// so the header and the page can never disagree: red = a post is at risk right now; amber =
// delivery degraded (cloud unreachable, sync stopped, subscription unreadable) while the
// local backstop covers it; yellow (neutral grey dot, healthDot) = a wait that resolves
// itself (approved posts awaiting the cloud's confirmation, or an on-flag drift pendpost is
// re-asserting), so no warning; green = all
// confirmed, which is an all-clear and so carries NO dot. `attention` covers the
// multi-project case: the ACTIVE project publishes locally, but another always-on project
// has a cloud problem - the dot still carries it, with the cloud glyph.
function deriveStatus({ running, cloudOn, health, attention = false }) {
  if (cloudOn || attention) {
    const dot = healthDot(health.state);
    if (health.state === 'red') return { Icon: CloudIcon, dot, key: 'connection.sync.broken' };
    if (health.state === 'amber') return { Icon: CloudIcon, dot, key: 'connection.sync.degraded' };
    // yellow is a self-resolving wait. Only a push awaiting its ack is "syncing n posts";
    // the other wait (an on-flag drift being re-asserted) is limited delivery, said plainly.
    if (health.state === 'yellow') {
      const pushing = !health.reason || health.reason === 'push_pending';
      return { Icon: CloudIcon, dot, key: pushing ? 'connection.sync.pending' : 'connection.sync.degraded' };
    }
    return { Icon: CloudIcon, dot: null, key: 'connection.status.cloud' };
  }
  if (running === true) return { Icon: Monitor, dot: null, key: 'connection.status.local' };
  if (running === false) return { Icon: MonitorOff, dot: 'bg-amber-500', key: 'connection.status.off' };
  return { Icon: CloudIcon, dot: null, key: 'connection.status.unknown' };
}

export default function ConnectionStatus({ running, onNavigate, onShowAtRisk, onIssueAction }) {
  const t = useT();
  const { data: cloud, refetch } = useCloud();
  // OPERATIONAL requires a workspace AND the api key - identical to Cloud.jsx's `connected`
  // gate. A configured-but-keyless connection (workspaceId set, PENDPOST_CLOUD_API_KEY
  // missing) cannot publish, so it must NOT read as cloud-on here; the page routes it to
  // the "finish setup" view and the local scheduler is the real firer.
  const cloudConnected = Boolean(cloud?.workspaceId && cloud?.apiKey?.present);
  // The glyph follows the SELECTED client, not the install: the cloud only fires a brand
  // that is itself always-on, so a connected install whose active client is NOT always-on
  // still publishes that client locally and must read as local here. Undefined while the
  // list loads -> falls back to the local-scheduler signal, no false "cloud".
  const { data: clientsData } = useCloudClients(cloudConnected);
  const activeAlwaysOn = ((clientsData?.clients) || []).find((c) => c.active)?.alwaysOn === true;
  const cloudOn = cloudConnected && Boolean(cloud?.enabled) && activeAlwaysOn;
  const { data: sub, isError: subFailed, refetch: refetchSub } = useCloudSubscription(cloudConnected);

  const sync = cloudConnected ? (cloud?.sync || null) : null;
  const health = cloudOn ? cloudHealth(sync, subFailed) : cloudHealth(sync, false);
  const attention = !cloudOn && (health.state === 'red' || health.state === 'amber');
  const { Icon, dot, key } = deriveStatus({ running, cloudOn, health, attention });
  // r5: a failed read of the plan info is not a limited cloud; the title says what failed.
  const statusKey = key === 'connection.sync.degraded' && health.reason === 'subscription_failed' ? 'connection.sync.subscriptionFailed' : key;
  const status = t(statusKey, statusKey === 'connection.sync.pending' ? { n: sync?.pendingCount ?? 0 } : undefined);
  const cloudSide = cloudOn || attention;
  const isBroken = cloudSide && health.state === 'red';
  // The detail behind the dot: one row per post / lane / connectivity problem, across every
  // always-on project (older engines send no issues[] -> the reason line below stands in).
  const issues = cloudSide && Array.isArray(sync?.issues) ? sync.issues : [];
  const shownIssues = issues.slice(0, MAX_ISSUES);
  const moreIssues = issues.length - shownIssues.length;
  // The project name only earns its place when more than one project runs in the cloud.
  const multiProject = ((clientsData?.clients) || []).filter((c) => c.alwaysOn).length > 1;
  // A reason sentence only where no issue row explains a non-green state (push pending,
  // subscription unreadable, sync stopped, on-flag drift, an unreadable plan): the rows are
  // the explanation otherwise. Every non-green state gets one.
  const reasonKey = cloudSide && issues.length === 0 && health.state && health.state !== 'green' && health.reason
    ? `connection.sync.reason.${health.reason}` : null;
  const reason = reasonKey && t(reasonKey) !== reasonKey ? t(reasonKey) : null;
  const allDelivered = cloudOn && health.state === 'green';
  // ONE state line replaces the old title + subtitle pair ("Stay online around the clock" /
  // "Publishing through the cloud"): it says what is true right now. With issues it counts
  // them - and names how many projects they span, which is why it can differ from the
  // header triangle and the sidebar "Overdue" count (both count THIS project only).
  const issueProjects = new Set(issues.filter((i) => !CONNECTIVITY.has(i.kind)).map((i) => i.clientId)).size;
  const headline = issues.length === 1 ? t('connection.state.issue')
    : issues.length > 1 ? (multiProject && issueProjects > 1
      ? t('connection.state.issuesProjects', { n: issues.length, p: issueProjects })
      : t('connection.state.issues', { n: issues.length }))
      : allDelivered ? t('connection.issue.allDelivered')
        : status;
  // The planner filter only remains for a red state no row explains: an unreadable plan
  // (manifest_error, zero counts by construction) or an older engine without issues[].
  const showPlanner = isBroken && issues.length === 0 && Boolean(onShowAtRisk);
  const recheck = () => { refetch?.(); refetchSub?.(); };

  // Controlled so the in-app "manage cloud" button can navigate AND close the popover.
  // (Wrapping that button in Radix <PopoverClose> swallowed its onClick, so the nav
  // never fired - the popover just closed. Close it explicitly via setOpen instead.)
  const [open, setOpen] = useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tip label={headline}>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={t('connection.aria')}
            className={`${TAP_TARGET} flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-zinc-200/60 transition hover:bg-zinc-300/60 dark:bg-zinc-800/60 dark:hover:bg-zinc-700/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand`}
          >
            <Icon size={14} aria-hidden="true" />
            {dot ? (
              <span
                className={`absolute right-1 top-1 h-2 w-2 rounded-full ring-2 ring-white dark:ring-zinc-900 ${dot}`}
                aria-hidden="true"
              />
            ) : null}
          </button>
        </PopoverTrigger>
      </Tip>
      {/* Full width on a phone (the old fixed 320px left a dead strip at 375px), the
          familiar 320px from sm up. collisionPadding (8px) keeps the gutter. */}
      <PopoverContent align="end" className="w-[calc(100vw-1rem)] space-y-3 p-3 sm:w-80" aria-label={t('connection.title')}>
        <div className="space-y-1">
          <p className="flex items-center gap-1.5 text-sm font-bold">
            <Icon size={14} className="shrink-0 text-zinc-500 dark:text-zinc-400" aria-hidden="true" />
            {headline}
          </p>
          {reason ? (
            <div className="space-y-1.5">
              <p className="text-[11px] leading-relaxed text-zinc-600 dark:text-zinc-300">{reason}</p>
              {!isBroken ? <RecheckButton onRecheck={recheck} /> : null}
            </div>
          ) : null}
          {/* Money truth stays visible: a used-up trial stops publishing. Everything else
              about the plan lives on the Cloud page, not in this status popover. */}
          {sub?.checkoutEligible ? (
            <p className="text-[11px] font-bold text-amber-700 dark:text-amber-400">{t('connection.needsPayment')}</p>
          ) : null}
        </div>
        {shownIssues.length ? (
          <ul className="space-y-1.5" aria-label={t('connection.issue.listAria')}>
            {shownIssues.map((issue, i) => (
              <CloudIssueRow
                key={`${issue.clientId}:${issue.kind}:${issue.campaign || ''}:${issue.postId || i}`}
                issue={issue}
                showProject={multiProject}
                onAction={onIssueAction ? (it, action) => { setOpen(false); onIssueAction(it, action); } : undefined}
                onRecheck={recheck}
              />
            ))}
            {moreIssues > 0 ? (
              <li>
                <button
                  type="button"
                  onClick={() => { onNavigate?.('cloud'); setOpen(false); }}
                  className={`flex w-full items-center justify-between gap-2 rounded-xl px-3 py-1.5 text-[11px] font-bold text-zinc-600 transition hover:bg-zinc-200/60 dark:text-zinc-300 dark:hover:bg-zinc-700/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand ${TAP_TARGET}`}
                >
                  {t('connection.issue.more', { n: moreIssues })}
                  <ArrowRight size={12} aria-hidden="true" />
                </button>
              </li>
            ) : null}
          </ul>
        ) : null}
        {!cloudConnected ? (
          <div className="space-y-0.5 rounded-xl bg-zinc-100/70 px-3 py-2 dark:bg-zinc-800/50">
            <p className="text-[11px] text-zinc-600 dark:text-zinc-300">{t('connection.price.selfHost')}</p>
            <p className="text-[11px] text-zinc-600 dark:text-zinc-300">{t('connection.price.cloud')}</p>
          </div>
        ) : null}
        <div className="flex flex-col gap-1.5 pt-0.5">
          {/* Every red (broken) state names the planner as where the fix lives, so the
              planner CTA is gated on isBroken alone (manifest_error carries zero counts). */}
          {showPlanner ? (
            <button
              type="button"
              onClick={() => { onShowAtRisk(); setOpen(false); }}
              className={`flex items-center justify-between gap-2 rounded-xl bg-brand px-3 py-2 text-xs font-bold text-white transition hover:opacity-90 dark:bg-brand-light dark:text-zinc-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand ${TAP_TARGET}`}
            >
              {t('connection.viewAtRisk')}
              <ArrowRight size={13} aria-hidden="true" />
            </button>
          ) : null}
          {/* One style in every state: "Manage cloud" is a quiet secondary whether the
              cloud is fine or not (it used to flip to a filled primary on green). The
              not-yet-connected upsell keeps its one primary "Set up" CTA. */}
          <button
            type="button"
            onClick={() => { onNavigate?.('cloud'); setOpen(false); }}
            className={`flex items-center justify-between gap-2 rounded-xl px-3 py-2 text-xs font-bold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand ${TAP_TARGET} ${cloudConnected ? 'bg-zinc-200/60 text-zinc-700 hover:bg-zinc-300/60 dark:bg-zinc-800/60 dark:text-zinc-200 dark:hover:bg-zinc-700/60' : 'bg-brand text-white hover:opacity-90 dark:bg-brand-light dark:text-zinc-900'}`}
          >
            {cloudConnected ? t('connection.manage') : t('connection.setup')}
            <ArrowRight size={13} aria-hidden="true" />
          </button>
          {/* The plans link belongs to the not-yet-connected upsell only; a
              connected workspace manages everything via "Manage cloud". */}
          {!cloudConnected ? (
            <a
              href={SERVICES_URL}
              target="_blank"
              rel="noopener noreferrer"
              className={`flex items-center justify-between gap-2 rounded-xl px-3 py-2 text-xs font-bold text-zinc-600 transition hover:bg-zinc-200/60 dark:text-zinc-300 dark:hover:bg-zinc-700/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand ${TAP_TARGET}`}
            >
              {t('connection.viewPlans')}
              <ExternalLink size={13} aria-hidden="true" />
            </a>
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  );
}
