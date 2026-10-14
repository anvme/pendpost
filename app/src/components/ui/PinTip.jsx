// PinTip - the house tooltip bubble that a touch user can reach too. Shared by ui/InfoTip.jsx
// (the "?" trigger) and ui/IconBadge.jsx (a labelled status chip).
//
//   <PinTip label="Die Meta-Publikations-Lane ist aktiv."><button ...>chip</button></PinTip>
//
// Wraps ONE focusable trigger element (Radix asChild). With no label it renders the child
// untouched, so callers pass an optional label without branching.
//
// Why not Tip (Tooltip.jsx): Tip opens on hover or KEYBOARD focus only (right for its callers,
// a tooltip must not linger after a mouse click moved focus), which leaves a touch user with
// no way in (canon Tier 2: no hover-only reveals on touch). This is a Radix Popover dressed as
// the house tooltip bubble:
//   - mouse hover opens it, leaving closes it (unless a click pinned it);
//   - a tap or Enter/Space (both arrive as a click) opens it pinned, a second one closes it;
//   - Escape, a tap outside, or focus moving on closes it (Radix DismissableLayer);
//   - focus never leaves the trigger.
// The bubble is role="tooltip" + data-infotip-content, the convention tests and flows query.
import { useRef, useState } from 'react';
import * as RP from '@radix-ui/react-popover';

export function PinTip({ label, side = 'top', children }) {
  const [open, setOpen] = useState(false);
  const pinned = useRef(false);
  if (!label) return children ?? null;

  const close = () => { pinned.current = false; setOpen(false); };
  const onClick = (e) => {
    // Radix's own trigger toggle is skipped (preventDefault), so a click after a hover-open
    // pins the bubble instead of closing what the pointer just showed.
    e.preventDefault();
    if (open && pinned.current) close();
    else { pinned.current = true; setOpen(true); }
  };

  return (
    <RP.Root open={open} onOpenChange={(next) => { if (!next) close(); }}>
      <RP.Trigger
        asChild
        onPointerEnter={(e) => { if (e.pointerType === 'mouse') setOpen(true); }}
        onPointerLeave={(e) => { if (e.pointerType === 'mouse' && !pinned.current) setOpen(false); }}
        onClick={onClick}
      >
        {children}
      </RP.Trigger>
      <RP.Portal>
        <RP.Content
          data-infotip-content=""
          role="tooltip"
          side={side}
          sideOffset={6}
          collisionPadding={8}
          onOpenAutoFocus={(e) => e.preventDefault()}
          onCloseAutoFocus={(e) => e.preventDefault()}
          className="z-[70] max-w-[16rem] break-words rounded-lg bg-zinc-900 px-2.5 py-1.5 text-[11px] font-medium leading-snug text-zinc-50 shadow-xl outline-none dark:bg-zinc-100 dark:text-zinc-900"
        >
          {label}
          <RP.Arrow className="fill-zinc-900 dark:fill-zinc-100" />
        </RP.Content>
      </RP.Portal>
    </RP.Root>
  );
}
