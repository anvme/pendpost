import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect } from 'vitest';
import { Gauge } from 'lucide-react';
import { IconBadge } from '../ui/IconBadge.jsx';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { TAP_TARGET } from '../ui/recipes.js';

// The static IconBadge variant lives INSIDE other interactive controls (a Planner
// card's open-detail button), so it must never render a focusable element - yet its
// label should still surface as the house Radix Tip on hover, not only as an
// accessible name. Guards both halves: real tooltip, zero nested interactivity.
function renderStatic() {
  return render(
    <TooltipProvider>
      <button type="button">
        open card
        <IconBadge icon={Gauge} tone="ok" text="HD" label="Serves in HD" static />
      </button>
    </TooltipProvider>,
  );
}

describe('IconBadge static variant', () => {
  it('renders no nested button and nothing focusable inside the host button', () => {
    const { container } = renderStatic();
    expect(container.querySelectorAll('button button')).toHaveLength(0);
    expect(container.querySelector('button [tabindex]')).toBeNull();
    // The label stays the accessible name on the badge itself.
    expect(screen.getByRole('img', { name: 'Serves in HD' })).toBeInTheDocument();
  });

  it('shows the Radix tooltip on hover', async () => {
    const user = userEvent.setup();
    renderStatic();
    await user.hover(screen.getByRole('img', { name: 'Serves in HD' }));
    // Radix renders the content into a portal once the delay elapses.
    await waitFor(() => expect(screen.getByRole('tooltip')).toHaveTextContent('Serves in HD'));
  });
});

// The INTERACTIVE variant (a labelled badge outside any other control) is a real <button>
// that triggers the house Tip. Its painted chip is ~20px tall, under the 44px floor (canon
// Tier 2, WCAG 2.5.5), so it carries the TAP_TARGET ::after box, but VERTICAL-ONLY: the box is
// 44px tall and exactly as wide as the chip, never min-w-11. Badges sit in tight `gap-1` rows
// (cover chips, spec chips, Setup status + beta chips), and a 44px-wide box on a 23px icon-only
// chip would reach 10px past each side, over its neighbour. The painted chip also sits above
// every hit box (relative z-[1]), so where a wrapped row's box does overlap a neighbour
// vertically, the chip you can SEE always wins the tap.
describe('IconBadge interactive variant: 44px hit area without a bigger chip', () => {
  const VERTICAL_ONLY = TAP_TARGET.split(/\s+/).filter((c) => c !== 'after:min-w-11');

  function renderRow() {
    return render(
      <TooltipProvider>
        <div className="flex flex-wrap gap-1">
          <IconBadge icon={Gauge} tone="ok" text="HD" label="Serves in HD" />
          <IconBadge icon={Gauge} tone="warn" label="Cover missing" />
          <IconBadge icon={Gauge} tone="neutral" text="plain" />
        </div>
      </TooltipProvider>,
    );
  }

  it('the trigger button carries the vertical-only tap box (44px tall, chip-wide)', () => {
    renderRow();
    for (const name of ['HD', 'Cover missing']) {
      const btn = screen.getByRole('button', { name });
      for (const cls of VERTICAL_ONLY) expect(btn).toHaveClass(cls);
      expect(btn).toHaveClass('after:h-11');
      expect(btn).toHaveClass('after:w-full');
      expect(btn).not.toHaveClass('after:min-w-11');
    }
  });

  it('keeps the painted chip exactly as it was, and above any neighbour hit box', () => {
    renderRow();
    const btn = screen.getByRole('button', { name: 'HD' });
    const chip = btn.firstElementChild;
    expect(chip).toHaveClass('px-1.5', 'py-0.5', 'text-[10px]', 'rounded-full', 'relative', 'z-[1]');
    // No size or padding utility sneaks onto the button: the row height is the chip's, as before.
    const classes = btn.className.split(/\s+/);
    expect(classes.filter((c) => /^(h|w|min-h|min-w|size|p|px|py)-/.test(c))).toEqual([]);
  });

  it('an unlabelled badge stays a plain chip: no button, no hit box', () => {
    const { container } = renderRow();
    expect(screen.getAllByRole('button')).toHaveLength(2);
    expect(screen.getByText('plain').parentElement.className).not.toMatch(/after:/);
    expect(container.querySelectorAll('[class*="after:h-11"]')).toHaveLength(2);
  });

  it('the static variant gets no hit box of its own (its host control owns the tap)', () => {
    const { container } = renderStatic();
    expect(container.querySelector('[role="img"]').className).not.toMatch(/after:/);
  });
});

// A 44px target that shows nothing on touch is still a hover-only reveal (canon Tier 2). So a
// labelled, interactive IconBadge reveals its label the way ui/InfoTip.jsx does (both share
// ui/PinTip.jsx): mouse hover opens the bubble, a tap or Enter/Space pins it, a second one
// unpins it, Escape or a tap outside closes it. The bubble is the house one: role="tooltip",
// data-infotip-content.
//
// Accessible name (judge final2): the visible word is the NAME and the label is the
// DESCRIPTION. As the name, a raw platform message ("Graph GET /me: HTTP 400 ...") replaced the
// status word for a screen reader. An icon-only chip has no word, so its label stays the name.
describe('IconBadge interactive variant: reveals its label on hover, tap and keyboard', () => {
  const LABEL = 'Die Meta-Publikations-Lane ist aktiv.';
  function renderChip() {
    return render(
      <TooltipProvider>
        <IconBadge icon={Gauge} tone="ok" text="Aktiv" label={LABEL} />
        <button type="button">elsewhere</button>
      </TooltipProvider>,
    );
  }
  const chip = () => screen.getByRole('button', { name: 'Aktiv' });
  const bubble = () => screen.queryByText(LABEL, { selector: '[data-infotip-content]' });

  it('names the chip by its visible word, describes it by the label, and paints nothing while closed', () => {
    renderChip();
    expect(chip()).toBeInTheDocument();
    expect(chip()).toHaveAccessibleDescription(LABEL);
    expect(screen.queryByRole('button', { name: LABEL })).toBeNull();
    expect(bubble()).toBeNull();
  });

  it('an icon-only chip keeps its label as the name (there is no word to name it by)', () => {
    render(
      <TooltipProvider>
        <IconBadge icon={Gauge} tone="warn" label="Cover missing" />
      </TooltipProvider>,
    );
    expect(screen.getByRole('button', { name: 'Cover missing' })).not.toHaveAttribute('aria-describedby');
  });

  it('opens on mouse hover as the house bubble and closes when the pointer leaves', async () => {
    const user = userEvent.setup();
    renderChip();
    await user.hover(chip());
    await waitFor(() => expect(bubble()).toBeInTheDocument());
    expect(bubble()).toHaveAttribute('role', 'tooltip');
    await user.unhover(chip());
    await waitFor(() => expect(bubble()).toBeNull());
  });

  it('opens on a tap (touch pointer, then click), stays open, and a second tap closes it', async () => {
    renderChip();
    fireEvent.pointerEnter(chip(), { pointerType: 'touch' });
    expect(bubble()).toBeNull();
    fireEvent.click(chip());
    await waitFor(() => expect(bubble()).toBeInTheDocument());
    fireEvent.pointerLeave(chip(), { pointerType: 'touch' });
    expect(bubble()).toBeInTheDocument();
    fireEvent.click(chip());
    await waitFor(() => expect(bubble()).toBeNull());
  });

  it('opens from the keyboard (Tab, Enter or Space), Escape closes it, focus stays on the chip', async () => {
    const user = userEvent.setup();
    renderChip();
    await user.tab();
    expect(chip()).toHaveFocus();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(bubble()).toBeInTheDocument());
    expect(chip()).toHaveFocus();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(bubble()).toBeNull());
    await user.keyboard(' ');
    await waitFor(() => expect(bubble()).toBeInTheDocument());
  });

  it('a tap outside closes a pinned bubble', async () => {
    const user = userEvent.setup();
    renderChip();
    fireEvent.click(chip());
    await waitFor(() => expect(bubble()).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'elsewhere' }));
    await waitFor(() => expect(bubble()).toBeNull());
  });

  it('the static variant is untouched: still the hover-only Radix Tip, never the pinnable bubble', async () => {
    const user = userEvent.setup();
    renderStatic();
    await user.hover(screen.getByRole('img', { name: 'Serves in HD' }));
    await waitFor(() => expect(screen.getByRole('tooltip')).toHaveTextContent('Serves in HD'));
    expect(document.querySelector('[data-infotip-content]')).toBeNull();
  });
});
