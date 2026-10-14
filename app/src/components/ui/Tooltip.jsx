// Tooltip primitive (Radix) - the house replacement for native title=. Wrap the
// app once in <TooltipProvider>, then use <Tip label="...">child</Tip>.
import * as RT from '@radix-ui/react-tooltip';
import { cn } from './cn.js';

export function TooltipProvider({ children }) {
  return (
    <RT.Provider delayDuration={200} skipDelayDuration={400}>
      {children}
    </RT.Provider>
  );
}

// Input modality, the same heuristic browsers use for :focus-visible: a keydown means
// the next focus is the keyboard's, a pointerdown means it is not. Starts as keyboard
// so a focus with no prior interaction still announces its label.
let keyboardModality = true;
if (typeof document !== 'undefined') {
  document.addEventListener('keydown', () => { keyboardModality = true; }, true);
  document.addEventListener('pointerdown', () => { keyboardModality = false; }, true);
  document.addEventListener('mousedown', () => { keyboardModality = false; }, true);
}

// Radix opens a tooltip on ANY focus of its trigger, including the programmatic
// focus a Popover or Dialog hands back to its trigger when it closes. After a mouse
// click on an action inside (say "Manage cloud", which also navigates), that left
// the trigger's tooltip open over the next page: nothing blurs the trigger and the
// pointer never leaves it. Only keyboard focus opens the tooltip; hover is untouched.
// Radix skips its own focus handler when ours calls preventDefault.
function openOnKeyboardFocusOnly(event) {
  if (!keyboardModality) event.preventDefault();
}

// Wraps a single focusable child. With no label it renders the child untouched,
// so callers can pass an optional label without branching.
export function Tip({ label, side = 'top', align = 'center', children }) {
  if (!label) return children;
  return (
    <RT.Root>
      <RT.Trigger asChild onFocus={openOnKeyboardFocusOnly}>{children}</RT.Trigger>
      <RT.Portal>
        <RT.Content
          side={side}
          align={align}
          sideOffset={6}
          collisionPadding={8}
          className={cn(
            'z-[70] max-w-[16rem] rounded-lg px-2.5 py-1.5 text-[11px] font-medium leading-snug shadow-xl',
            'bg-zinc-900 text-zinc-50 dark:bg-zinc-100 dark:text-zinc-900',
          )}
        >
          {label}
          <RT.Arrow className="fill-zinc-900 dark:fill-zinc-100" />
        </RT.Content>
      </RT.Portal>
    </RT.Root>
  );
}
