import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { CalendarDays, Activity, BarChart3, CheckCircle2, Play, Square, Plus, Settings, ChevronRight, ChevronDown, Clock, FolderOpen, Users, Send, Wrench, LifeBuoy, Cloud, Monitor, CornerUpLeft, Radar, Loader2 } from 'lucide-react';
import { setSchedulerRunning, useSignals } from '../lib/api.js';
import { useCloud, useCloudClients } from '../lib/cloud.js';
import { fmtTime, fmtDayShort, fmtFull } from '../lib/format.js';
import { useT } from '../lib/i18n.js';
import { INNER_SURFACE, PLATFORM_META, DISABLED_PRIMARY } from './ui.jsx';
import ClientSwitcher from './ClientSwitcher.jsx';
import { Popover, PopoverTrigger, PopoverContent, PopoverClose } from './ui/Popover.jsx';
import { Tip } from './ui/Tooltip.jsx';
import FeedbackDialog from './FeedbackDialog.jsx';

// `dot` - the quiet unread marker (like a chat app's): a small brand dot beside the badge,
// with its meaning in an sr-only label (never colour-only for screen readers).
export function NavItem({ icon: Icon, label, active, badge, badgeLabel, dot, dotLabel, disabled, onClick }) {
  const cls = active
    ? 'bg-brand text-white shadow-lg shadow-brand/20 font-bold dark:bg-brand-light dark:text-zinc-900'
    : disabled
      ? 'text-zinc-500 dark:text-zinc-400'
      : 'text-zinc-600 transition hover:bg-zinc-200/50 dark:text-zinc-300 dark:hover:bg-zinc-800/50';
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-current={active ? 'page' : undefined}
      className={`flex w-full items-center gap-2.5 rounded-xl px-3 py-1.5 text-left text-sm focus-visible:ring-2 focus-visible:ring-brand ${cls}`}
    >
      <Icon size={16} aria-hidden="true" />
      <span className="flex-1">{label}</span>
      {dot ? (
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${active ? 'bg-white dark:bg-zinc-900' : 'bg-brand dark:bg-brand-light'}`}>
          <span className="sr-only">{dotLabel}</span>
        </span>
      ) : null}
      {badge ? (
        <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-bold ${active ? 'bg-white/25 text-white dark:bg-zinc-900/20 dark:text-zinc-900' : 'bg-zinc-200/80 text-zinc-500 dark:bg-zinc-700/80 dark:text-zinc-400'}`}>
          <span aria-hidden="true">{badge}</span>
          {badgeLabel ? <span className="sr-only">{badgeLabel}</span> : null}
        </span>
      ) : null}
    </button>
  );
}

// US-ONB-10: starting the scheduler is gated on pendpost readiness, mirroring the
// canonical ReadinessChecklist (disabled until ready, with a waiting tooltip).
// `setupReady === false` is the only blocking state; null/undefined (signal not
// yet loaded) does not lock the control. Stopping a running scheduler is always
// allowed.
export function SchedulerToggle({ running, setupReady }) {
  const t = useT();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const blockedNotReady = !running && setupReady === false;
  const toggle = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await setSchedulerRunning(!running);
    } finally {
      setBusy(false);
      queryClient.invalidateQueries({ queryKey: ['accounts'] });
      queryClient.invalidateQueries({ queryKey: ['plans'] });
    }
  };
  const label = running
    ? t('sidebar.scheduler.stop')
    : blockedNotReady
      ? t('readiness.scheduler.waiting')
      : t('sidebar.scheduler.startHelp');
  return (
    <Tip label={label}>
      <button
        type="button"
        onClick={toggle}
        disabled={busy || blockedNotReady}
        aria-label={blockedNotReady ? t('readiness.scheduler.waiting') : running ? t('sidebar.scheduler.stop') : t('sidebar.scheduler.start')}
        className="rounded-lg p-1.5 transition hover:bg-zinc-200/60 dark:hover:bg-zinc-700/60 focus-visible:ring-2 focus-visible:ring-brand disabled:opacity-50"
      >
        {running ? <Square size={13} aria-hidden="true" /> : <Play size={13} aria-hidden="true" />}
      </button>
    </Tip>
  );
}

export default function Sidebar({ accounts, posting, pendingCount, nextPost, attention, setupReady, setupIncomplete, activePage, open, onNavigate, onNew, onNewThread, onOpenPost, onShowOverdue, onCreateProject, onBeforeSwitchClient, allClients = false, onAllClientsChange }) {
  const t = useT();
  const [showFeedback, setShowFeedback] = useState(false);
  // The Radar nav row reflects the live scan (owner ask 2026-07-20): while a research job
  // runs, the Beta chip yields to a small spinner - and because this subscription shares the
  // panel's query, the 3s job poll stays alive when the operator navigates away mid-scan.
  // Off-radar it costs one cached read (staleTime); disabled Radar never fetches at all.
  const radarEnabled = posting?.radar?.enabled === true;
  const { data: radarFeed } = useSignals(radarEnabled);
  const radarScanning = radarEnabled && (radarFeed?.jobs || []).some((j) => j.state === 'running');
  // New-signals count: how many signals were found since the last Radar visit (the same
  // localStorage clock the panel's "Neu" chips read). Rendered as a quiet count pill, like
  // Freigaben/Setup - it replaces the old unread dot (one signal, not two). Suppressed while
  // you are ON the page - the chips carry it there - and while scanning, where the spinner is
  // the louder truth. Zero => no badge at all (no "Beta" chip; that lives on the page header).
  const radarNewCount = radarEnabled && !radarScanning && activePage !== 'radar' ? (() => {
    try {
      const seen = localStorage.getItem('pendpost.radar.lastSeen');
      return seen ? (radarFeed?.items || []).filter((s) => s.foundAt && s.foundAt > seen).length : 0;
    } catch { return 0; }
  })() : 0;

  const schedulerRunning = Boolean(accounts?.scheduler?.running);
  // Surface the last sweep so an EMPTY sweep (nothing was due) is still visible
  // proof the scheduler ran - otherwise an idle "Aktiv" looks indistinguishable
  // from a wedged loop. fmtTime keeps it readable in the narrow sidebar column.
  const schedulerLastRun = accounts?.scheduler?.lastRun;

  // Delivery (item 11): the row reflects how the ACTIVE client publishes, not the raw
  // local tick. When the active brand is cloud-managed, the local 60s loop is NOT firing
  // it (the cloud is), so "Aktiv (60s-Zyklus)" would misread as local publishing - we show
  // "Cloud · rund um die Uhr" instead. The local loop still runs for reconciliation + other
  // brands, so for a local active client we keep the scheduler label + start/stop control.
  const { data: cloud } = useCloud();
  const cloudConnected = Boolean(cloud?.workspaceId && cloud?.apiKey?.present);
  const { data: cloudClientsData } = useCloudClients(cloudConnected);
  const activeOnCloud = cloudConnected && Boolean(cloud?.enabled) && ((cloudClientsData?.clients) || []).find((c) => c.active)?.alwaysOn === true;
  const deliveryLocalState = schedulerRunning ? t('sidebar.delivery.localActive') : t('sidebar.delivery.localPaused');
  const deliveryLastRun = schedulerLastRun ? t('settings.lastRun', { value: fmtTime(schedulerLastRun) }) : null;

  return (
    // Below lg this is an off-canvas drawer: fixed, hidden (translated + invisible
    // so it stays out of the tab order) until `open`, then slid in with a scrim.
    // At lg+ every narrow utility is reset to the original permanent rail, no
    // visual change on desktop. `open` is only ever true on narrow, so the dialog
    // semantics never attach to the desktop rail. overflow-y-auto holds at every
    // width: the rail is its own fixed column beside <main>, so on a short window
    // (1280x600) it scrolls itself instead of running past the h-dvh frame, where
    // its bottom rows were clipped and unreachable.
    <aside
      id="app-sidebar"
      role={open ? 'dialog' : undefined}
      aria-modal={open ? 'true' : undefined}
      aria-label={open ? t('sidebar.mainNav') : undefined}
      className={`glass-panel fixed inset-y-4 left-4 z-50 flex w-60 shrink-0 flex-col gap-3 overflow-y-auto scrollbar-soft rounded-2xl p-4 transition-transform duration-200 motion-reduce:transition-none lg:w-sidebar lg:static lg:inset-auto lg:left-auto lg:z-10 lg:translate-x-0 lg:transition-none ${open ? 'translate-x-0' : 'invisible -translate-x-[calc(100%+1.5rem)] lg:visible'}`}
    >
      <div>
        <p className="font-display text-lg font-bold text-brand dark:text-brand-light">pendpost</p>
        <p className="font-display text-xs text-zinc-500 dark:text-zinc-400">{t('sidebar.tagline')}</p>
      </div>

      {/* Multi-client switcher: the first thing the eye lands on, so the active
          client is unmistakable (anti-goal: acting on the wrong client). */}
      <ClientSwitcher onManage={() => onNavigate('clients')} onCreate={onCreateProject} onBeforeSwitch={onBeforeSwitchClient} allClients={allClients} onAllClientsChange={onAllClientsChange} />

      {/* Primary action: always one click away. The tooltip surfaces the
          otherwise-undiscoverable ⌘K palette (no inline kbd chip - it cost the
          width that wrapped the German label onto two lines). */}
      {/* Split primary action: the main click stays "New post" (one click away);
          the caret opens a small menu to start a New post or a New X thread. */}
      {/* Issue 6 step 5: a new post needs one client, so the primary create action
          is disabled (never hidden - the position and the reason both stay legible)
          while all-clients mode is on. Forcing a picker here would add a decision;
          picking a single client (the switcher's own row) already clears the mode. */}
      <div className="flex items-stretch gap-1">
        <Tip label={allClients ? t('composer.pickClientFirst') : t('sidebar.commandPalette')}>
          <button
            type="button"
            onClick={onNew}
            disabled={allClients}
            aria-disabled={allClients || undefined}
            className={`flex flex-1 items-center justify-center gap-1.5 rounded-l-xl rounded-r-md bg-brand px-3 py-2.5 text-sm font-bold text-white shadow-lg shadow-brand/20 transition hover:bg-brand/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:pointer-events-none dark:bg-brand-light dark:text-zinc-900 ${DISABLED_PRIMARY}`}
          >
            <Plus size={16} aria-hidden="true" />
            <span className="flex-1 whitespace-nowrap text-center">{t('composer.newPost')}</span>
          </button>
        </Tip>
        <Popover>
          <Tip label={allClients ? t('composer.pickClientFirst') : t('sidebar.newMenu')}>
            <PopoverTrigger
              disabled={allClients}
              aria-disabled={allClients || undefined}
              className={`grid place-items-center rounded-l-md rounded-r-xl bg-brand px-2 text-white shadow-lg shadow-brand/20 transition hover:bg-brand/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:pointer-events-none dark:bg-brand-light dark:text-zinc-900 ${DISABLED_PRIMARY}`}
              aria-label={t('sidebar.newMenu')}
            >
              <ChevronDown size={16} aria-hidden="true" />
            </PopoverTrigger>
          </Tip>
          <PopoverContent align="end" className="w-48">
            <PopoverClose asChild>
              <button type="button" onClick={onNew} className="flex w-full items-center gap-2 rounded-xl px-2.5 py-2 text-left text-sm font-semibold transition hover:bg-zinc-200/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:hover:bg-zinc-700/60">
                <Plus size={15} aria-hidden="true" /> {t('composer.newPost')}
              </button>
            </PopoverClose>
            <PopoverClose asChild>
              <button type="button" onClick={() => onNewThread?.()} className="flex w-full items-center gap-2 rounded-xl px-2.5 py-2 text-left text-sm font-semibold transition hover:bg-zinc-200/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:hover:bg-zinc-700/60">
                <CornerUpLeft size={15} aria-hidden="true" /> {t('threadComposer.new')}
              </button>
            </PopoverClose>
          </PopoverContent>
        </Popover>
      </div>

      {/* Nav order (item 9): the daily workflow on top - create -> approve -> see results ->
          monitor -> measure - then content + clients, then the system/config group (cloud,
          setup, settings) set off by a subtle gap rather than a divider line. */}
      <nav className="space-y-1" aria-label={t('sidebar.mainNav')}>
        <NavItem icon={CalendarDays} label={t('nav.planner')} active={activePage === 'planner'} onClick={() => onNavigate('planner')} />
        <NavItem
          icon={CheckCircle2}
          label={t('nav.approvals')}
          badge={pendingCount ? String(pendingCount) : undefined}
          badgeLabel={pendingCount ? t('sidebar.pendingBadge', { count: pendingCount }) : undefined}
          active={activePage === 'freigaben'}
          onClick={() => onNavigate('freigaben')}
        />
        <NavItem icon={Send} label={t('nav.published')} active={activePage === 'published'} onClick={() => onNavigate('published')} />
        <NavItem icon={Activity} label={t('nav.activity')} active={activePage === 'activity'} onClick={() => onNavigate('activity')} />
        <NavItem icon={BarChart3} label={t('nav.insights')} active={activePage === 'insights'} onClick={() => onNavigate('insights')} />
        {/* Radar (spec 32) social listening: while a scan runs the badge is a spinner; otherwise
            it is a quiet count of signals found since your last visit (nothing when there are none).
            "Beta" is not shown here - it lives on the Radar page header. The page itself gates on
            posting.radar.enabled (off by default), like the cloud row. */}
        <NavItem
          icon={Radar}
          label={t('nav.radar')}
          badge={radarScanning ? <Loader2 size={11} className="animate-spin" aria-hidden="true" /> : (radarNewCount > 0 ? String(radarNewCount) : undefined)}
          badgeLabel={radarScanning ? t('sidebar.radarScanning') : (radarNewCount > 0 ? t('sidebar.radarNewBadge', { count: radarNewCount }) : undefined)}
          active={activePage === 'radar'}
          onClick={() => onNavigate('radar')}
        />
        <NavItem icon={FolderOpen} label={t('nav.assets')} active={activePage === 'assets'} onClick={() => onNavigate('assets')} />
        <NavItem icon={Users} label={t('nav.clients')} active={activePage === 'clients'} onClick={() => onNavigate('clients')} />
        <div className="pt-1" aria-hidden="true" />
        {/* Managed cloud: an OPTIONAL paid always-on runtime on top of the free
            self-host core. The nav item is always present; the page itself gates
            on the server's `enabled` flag (off by default). */}
        <NavItem icon={Cloud} label={t('nav.cloud')} active={activePage === 'cloud'} onClick={() => onNavigate('cloud')} />
        {/* Setup nav with a calm "incomplete (N)" reflection: only when the
            server's setup signal is explicitly NOT ready. Skipped platforms are
            already excluded from the count server-side, so an all-skipped pendpost
            reads ready and shows no badge. This badge is the rail's ONE lane-health
            signal: a colour dot beside lane logos said the same thing by colour
            alone, so it was removed (final judge). Per-lane detail lives on Setup. */}
        <NavItem
          icon={Wrench}
          label={t('nav.setup')}
          badge={setupReady === false && setupIncomplete > 0 ? String(setupIncomplete) : undefined}
          badgeLabel={setupReady === false && setupIncomplete > 0 ? t('sidebar.setupBadge', { count: setupIncomplete }) : undefined}
          active={activePage === 'setup'}
          onClick={() => onNavigate('setup')}
        />
        <NavItem icon={Settings} label={t('nav.settings')} active={activePage === 'settings'} onClick={() => onNavigate('settings')} />
      </nav>

      {/* Ops scent (UX-03): what happens next + what needs attention - both clickable. */}
      <div className="space-y-2">
        {nextPost ? (() => {
          // Platform glyph + a one-line content preview (title, else the caption's
          // first line, else the type) - the same computation the aria-label uses.
          const nextMeta = PLATFORM_META[nextPost.platforms?.[0]];
          const preview = nextPost.title || nextPost.caption?.split('\n')[0] || t(`type.${nextPost.type}`);
          return (
            <button
              type="button"
              onClick={() => onOpenPost(nextPost)}
              aria-label={t('sidebar.nextPostAria', {
                when: fmtFull(nextPost.scheduledAt),
                type: t(`type.${nextPost.type}`),
                title: preview,
              })}
              className={`group flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left transition hover:ring-brand/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand ${INNER_SURFACE}`}
            >
              {nextMeta ? (
                <nextMeta.Icon size={14} className={`shrink-0 ${nextMeta.color}`} aria-hidden="true" />
              ) : (
                <Clock size={15} className="shrink-0 text-zinc-500 dark:text-zinc-400" aria-hidden="true" />
              )}
              <p className="min-w-0 flex-1 truncate text-xs">
                <span className="font-bold">{fmtDayShort(new Date(nextPost.scheduledAt))} {fmtTime(nextPost.scheduledAt)}</span>
                <span className="text-zinc-500 dark:text-zinc-400"> · {preview}</span>
              </p>
              <ChevronRight size={14} className="shrink-0 text-zinc-500 transition group-hover:translate-x-0.5" aria-hidden="true" />
            </button>
          );
        })() : null}
        {attention ? (() => {
          // One slot, the card's word (lib/format.js attentionSummary): "Wartet auf dich: n"
          // for refusals only the operator can fix, "Überfällig: n" otherwise.
          const needsYou = attention.kind === 'needs-you';
          const label = t(needsYou ? 'sidebar.needsYou' : 'sidebar.overdue', { count: attention.count });
          const hint = t(needsYou ? 'status.tip.publish-needs-you' : 'sidebar.overdueHint');
          return (
          <Tip label={hint}>
            <button
              type="button"
              onClick={onShowOverdue}
              aria-label={`${label}: ${hint}`}
              className="group flex w-full items-center gap-2 rounded-xl bg-red-500/10 px-3 py-2 text-left ring-1 ring-red-500/40 transition hover:bg-red-500/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500"
            >
              {/* Live "needs attention" ping so overdue posts are impossible to miss
                  after the Mac was asleep/offline - the scheduler auto-catches up, but
                  this makes the catch-up visible and one click from publishing. The
                  "review and publish" hint lives in the tooltip + aria-label. */}
              <span className="relative flex h-2 w-2 shrink-0" aria-hidden="true">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-500/70" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-red-500" />
              </span>
              <p className="min-w-0 flex-1 truncate text-xs font-bold text-red-700 dark:text-red-300">{label}</p>
              <ChevronRight size={14} className="shrink-0 text-red-500 transition group-hover:translate-x-0.5" aria-hidden="true" />
            </button>
          </Tip>
          );
        })() : null}
      </div>

      <div className="mt-auto space-y-2">
        {/* Delivery (item 11): the sidebar row exists only for LOCAL delivery,
            where it carries the scheduler start/stop control. A cloud-managed
            client's round-the-clock status is already asserted by the header
            ConnectionStatus glyph, so the sidebar no longer restates it here. */}
        {activeOnCloud ? null : (
          <div className={`flex items-center gap-2 rounded-xl px-3 py-2 ${INNER_SURFACE}`}>
            {/* Always grey: delivery running normally is an all-clear, which gets no colour (canon
                Tier 2). The sub-line says running or paused in words. */}
            <Monitor size={15} className="shrink-0 text-zinc-500 dark:text-zinc-400" aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs font-bold leading-tight">{t('sidebar.delivery.title')}</p>
              {/* Two unbroken fragments that wrap at the dot, so a narrow rail never cuts the
                  last-run time mid-word ("Lokal · aktiv · Letzter La..."). */}
              <p className="flex flex-wrap gap-x-1 text-[11px] text-zinc-500 dark:text-zinc-400">
                <span className="whitespace-nowrap">{deliveryLocalState}</span>
                {deliveryLastRun ? (
                  <>
                    <span aria-hidden="true">·</span>
                    <span className="whitespace-nowrap">{deliveryLastRun}</span>
                  </>
                ) : null}
              </p>
            </div>
            {accounts ? <SchedulerToggle running={schedulerRunning} setupReady={setupReady} /> : null}
          </div>
        )}
        <NavItem icon={LifeBuoy} label={t('feedback.nav')} onClick={() => setShowFeedback(true)} />
      </div>

      {showFeedback ? <FeedbackDialog onClose={() => setShowFeedback(false)} /> : null}
    </aside>
  );
}
