// InfoTip - the visible, focusable "?" trigger for a detail that must never be hover-only.
//
//   <InfoTip label="BLUESKY_IDENTIFIER, BLUESKY_APP_PASSWORD">Handle fehlt in der .env.</InfoTip>
//
// `label` is the detail it reveals (the same meaning as Tip's `label`); `children` is the
// optional plain text it annotates, rendered before the trigger. With no label it renders
// only its children, so callers pass an optional detail without branching. `triggerLabel`
// optionally names the trigger when a row holds several (Field passes "Hilfe: <field>"), so
// each "?" is told apart by name; it defaults to the generic "Mehr dazu".
// `side` (top | bottom | left | right, default top) is where the bubble opens, forwarded to
// PinTip: a tip sitting directly under an action row opens "bottom" so it never covers the
// buttons above it.
//
// Why not Tip: Tip opens on hover or keyboard focus only, which leaves a touch user with no
// way in. The bubble is ui/PinTip.jsx (shared with the labelled IconBadge chips): hover opens
// it, a tap or Enter/Space pins it, Escape or a tap outside closes it. Focus never leaves the
// trigger, and the detail is the trigger's accessible description at all times (the sr-only
// span below), so a screen reader hears it without opening anything.
// The glyph is the house HelpCircle "?" at 12px; TAP_TARGET gives it the invisible 44px hit
// area without growing the painted box. The ::after reaches 16px past each side of the glyph,
// so the trigger keeps 12px of right margin: with the usual 6-8px row gap the next control's
// box starts 18px or more away and the two targets stay apart. (10px + a 6px gap met at exactly
// 16px and the neighbour won the edge pixel: measured 43px wide on the Radar notice.)
import { useId } from 'react';
import { HelpCircle } from 'lucide-react';
import { useT } from '../../lib/i18n.js';
import { TAP_TARGET } from './recipes.js';
import { PinTip } from './PinTip.jsx';
import { cn } from './cn.js';

export default function InfoTip({ label, triggerLabel = null, side = 'top', children }) {
  const t = useT();
  const descId = useId();
  if (!label) return children ?? null;

  return (
    <span className="inline-flex items-center gap-1">
      {children}
      <PinTip label={label} side={side}>
        <button
          type="button"
          aria-label={triggerLabel || t('ui.infoTip.trigger')}
          aria-describedby={descId}
          data-infotip=""
          className={cn(
            'mr-3 inline-flex shrink-0 items-center rounded text-zinc-500 transition hover:text-zinc-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:text-zinc-400 dark:hover:text-zinc-200',
            TAP_TARGET,
          )}
        >
          <HelpCircle size={12} aria-hidden="true" />
        </button>
      </PinTip>
      <span id={descId} className="sr-only">{label}</span>
    </span>
  );
}
