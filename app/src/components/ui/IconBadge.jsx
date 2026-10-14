// Secondary-label primitive: a technical/secondary flag rendered as an icon in a
// colored ring with a tooltip explanation, plus optional inline text where there
// is room. The owner rule: compact icon+color+tooltip, full text only where
// space and clarity warrant it. Focusable, and the label opens on hover, tap or
// Enter/Space (PinTip), so it is reachable by mouse, touch and keyboard.
import { useId } from 'react';
import { Tip } from './Tooltip.jsx';
import { PinTip } from './PinTip.jsx';
import { TAP_TARGET_Y } from './recipes.js';
import { cn } from './cn.js';

// `ok` is an ALL-CLEAR state ("Verbunden", "Aktiv", "HD"), and canon Tier 2 spends colour only
// on attention: an all-clear state gets no colour, so green never becomes the background that
// dulls a real red. It therefore renders exactly as `neutral`; the icon and the word carry the
// meaning (status is never colour-only). Callers keep writing tone="ok" so the semantic stays
// readable at the call site and one place decides how an all-clear looks.
const NEUTRAL = 'bg-zinc-500/15 text-zinc-600 ring-zinc-500/30 dark:text-zinc-300';
const TONES = {
  ok: NEUTRAL,
  warn: 'bg-amber-500/15 text-amber-700 ring-amber-500/30 dark:text-amber-300',
  err: 'bg-red-500/15 text-red-700 ring-red-500/30 dark:text-red-300',
  info: 'bg-sky-500/15 text-sky-700 ring-sky-500/30 dark:text-sky-300',
  neutral: NEUTRAL,
};

const CHIP = 'inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-bold ring-1';

export function IconBadge({ icon: Icon, tone = 'neutral', label, text, side = 'top', static: isStatic = false }) {
  const descId = useId();
  const toneCls = TONES[tone] || TONES.neutral;
  const glyph = Icon ? <Icon size={11} aria-hidden="true" /> : null;
  const chip = <span className={cn(CHIP, toneCls)}>{glyph}{text ? <span>{text}</span> : null}</span>;
  if (!label) return chip;
  // Static variant: a NON-interactive labelled span, never a Radix Tooltip trigger
  // <button>. Use it wherever the badge lives INSIDE another interactive control (a
  // card's open-detail button), where a nested button is invalid HTML AND focusable
  // content inside a button violates the nested-interactive rule. The span still
  // triggers the house Tip on hover (Radix asChild, no tabIndex so nothing gains
  // focus), and the label stays the accessible name (role="img" + aria-label). It gets
  // no hit box of its own: a tap on it is the host control's tap.
  if (isStatic) {
    return (
      <Tip label={label} side={side}>
        <span role="img" aria-label={label} className={cn(CHIP, toneCls)}>
          {glyph}
          {text ? <span aria-hidden="true">{text}</span> : null}
        </span>
      </Tip>
    );
  }
  // Interactive variant: the ~20px chip gets a 44px-tall hit box (TAP_TARGET_Y, canon Tier 2)
  // that is exactly chip-wide, never min-w-11: badges sit in `gap-1` rows, and a 44px-wide
  // box would reach past a small chip into its neighbour. The painted chip is lifted above
  // every hit box (relative z-[1]), so in a wrapped row the chip you can see wins the tap.
  //
  // It reveals its label through PinTip, the bubble ui/InfoTip.jsx uses: hover opens it, a tap
  // or Enter/Space pins it, Escape or a tap outside closes it. A 44px target that showed
  // nothing on a tap would still be a hover-only reveal (canon Tier 2).
  //
  // Accessible name: the visible word when there is one ("Verbindung fehlgeschlagen"), and the
  // label becomes the button's DESCRIPTION (sr-only, always present, like ui/InfoTip.jsx). The
  // label can be a long sentence or a platform's raw message; as the name, a screen reader read
  // "Graph GET /me: HTTP 400 ..." instead of the status, and the visible word was missing from
  // the name (WCAG 2.5.3 label in name). An icon-only chip has no word, so its label stays the name.
  return (
    <>
      <PinTip label={label} side={side}>
        <button
          type="button"
          aria-label={text ? undefined : label}
          aria-describedby={text ? descId : undefined}
          className={cn('rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand', TAP_TARGET_Y)}
        >
          <span className={cn('relative z-[1]', CHIP, toneCls)}>{glyph}{text ? <span>{text}</span> : null}</span>
        </button>
      </PinTip>
      {text ? <span id={descId} className="sr-only">{label}</span> : null}
    </>
  );
}
