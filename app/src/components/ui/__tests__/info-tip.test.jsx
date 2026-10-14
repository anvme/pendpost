import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect } from 'vitest';
import InfoTip from '../InfoTip.jsx';
import { I18nProvider } from '../../../lib/i18n.js';
import { TooltipProvider } from '../Tooltip.jsx';
import { TAP_TARGET } from '../recipes.js';

// InfoTip is the visible, focusable "?" trigger for a detail that must never be hover-only
// (canon Tier 2: no hover-only reveals on touch; tap targets >= 44px). `label` is the detail
// it reveals (the same meaning as Tip's label), `children` the plain text it annotates.
// It opens on mouse hover, on a tap, and on Enter/Space from the keyboard; Escape closes it.

function renderTip(props = {}) {
  return render(
    <I18nProvider>
      <TooltipProvider>
        <InfoTip label="BLUESKY_IDENTIFIER, BLUESKY_APP_PASSWORD" {...props}>Handle is missing.</InfoTip>
        <button type="button">elsewhere</button>
      </TooltipProvider>
    </I18nProvider>,
  );
}

const trigger = () => screen.getByRole('button', { name: /more about this/i });
const bubble = () => screen.queryByText('BLUESKY_IDENTIFIER, BLUESKY_APP_PASSWORD', { selector: '[data-infotip-content]' });

describe('InfoTip', () => {
  it('renders the annotated text and a visible, focusable trigger with the 44px tap area', () => {
    renderTip();
    expect(screen.getByText('Handle is missing.')).toBeInTheDocument();
    const btn = trigger();
    expect(btn.tagName).toBe('BUTTON');
    for (const cls of TAP_TARGET.split(' ')) expect(btn.className).toContain(cls);
    // Closed: the detail is not painted, but a screen reader still gets it as the description.
    expect(bubble()).toBeNull();
    expect(btn).toHaveAccessibleDescription('BLUESKY_IDENTIFIER, BLUESKY_APP_PASSWORD');
  });

  // The ::after box reaches 16px past each side of the 12px glyph. A 12px right margin plus the
  // usual 6px row gap puts the next control 18px away, so the boxes never touch (10px + 6px met
  // at exactly 16px and lost the edge pixel: measured 43px wide on the Radar notice).
  it('keeps a 12px right margin so the next control never covers the edge of its tap box', () => {
    renderTip();
    expect(trigger().className).toMatch(/\bmr-3\b/);
  });

  it('opens on mouse hover and closes when the pointer leaves', async () => {
    const user = userEvent.setup();
    renderTip();
    await user.hover(trigger());
    await waitFor(() => expect(bubble()).toBeInTheDocument());
    await user.unhover(trigger());
    await waitFor(() => expect(bubble()).toBeNull());
  });

  it('opens on a tap (touch pointer, then click) and stays open until tapped again', async () => {
    renderTip();
    const btn = trigger();
    fireEvent.pointerEnter(btn, { pointerType: 'touch' });
    expect(bubble()).toBeNull(); // a touch "hover" is not an open
    fireEvent.click(btn);
    await waitFor(() => expect(bubble()).toBeInTheDocument());
    fireEvent.pointerLeave(btn, { pointerType: 'touch' });
    expect(bubble()).toBeInTheDocument();
    fireEvent.click(btn);
    await waitFor(() => expect(bubble()).toBeNull());
  });

  it('opens from the keyboard (Tab, then Enter or Space) and Escape closes it', async () => {
    const user = userEvent.setup();
    renderTip();
    await user.tab();
    expect(trigger()).toHaveFocus();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(bubble()).toBeInTheDocument());
    expect(trigger()).toHaveFocus(); // focus stays on the trigger
    await user.keyboard('{Escape}');
    await waitFor(() => expect(bubble()).toBeNull());
    await user.keyboard(' ');
    await waitFor(() => expect(bubble()).toBeInTheDocument());
  });

  it('a hover-open then a click pins it open (the click never closes what hover just showed)', async () => {
    const user = userEvent.setup();
    renderTip();
    await user.hover(trigger());
    await waitFor(() => expect(bubble()).toBeInTheDocument());
    await user.click(trigger());
    expect(bubble()).toBeInTheDocument();
    await user.unhover(trigger());
    expect(bubble()).toBeInTheDocument();
  });

  it('with no label it renders only its children (callers need not branch)', () => {
    renderTip({ label: '' });
    expect(screen.getByText('Handle is missing.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /more about this/i })).toBeNull();
  });
  // D6: a tip that sits directly under an action row opens BELOW its trigger, so the bubble
  // never covers those buttons. InfoTip forwards `side` to the PinTip bubble (default top).
  it('forwards `side` to the bubble (default top)', async () => {
    const user = userEvent.setup();
    const { unmount } = renderTip();
    await user.click(trigger());
    await waitFor(() => expect(bubble()).toBeInTheDocument());
    expect(bubble().getAttribute('data-side')).toBe('top');
    unmount();
    renderTip({ side: 'bottom' });
    await user.click(trigger());
    await waitFor(() => expect(bubble()).toBeInTheDocument());
    expect(bubble().getAttribute('data-side')).toBe('bottom');
  });
});
