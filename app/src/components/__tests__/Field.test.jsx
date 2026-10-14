import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect } from 'vitest';
import Field from '../ui/Field.jsx';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { TAP_TARGET } from '../ui/recipes.js';

// Field is the ONE labelled-text-input primitive (block label above a full-width
// input), extracted so ConnectPanel / AgentTokenPanel / IdentifierRow can never
// again hand-roll a wrapper that lets an inline label overlap an intrinsic-width
// input. The regression this file exists to refuse: an input without w-full.
function renderField(props) {
  return render(
    <TooltipProvider>
      <Field label="Client secret" {...props} />
    </TooltipProvider>,
  );
}

describe('Field primitive', () => {
  it('associates the label with the input so it is reachable by its name', () => {
    renderField({ value: '', onChange: () => {} });
    expect(screen.getByLabelText('Client secret')).toBeInTheDocument();
  });

  // THE regression guard (flywheel step 7): the measured bug was a FIELD input
  // with no width, collapsing to intrinsic width and floating beside an inline
  // label. The primitive forces w-full; this test refuses any future drift.
  it('always renders the input full-width', () => {
    renderField({ value: '', onChange: () => {} });
    expect(screen.getByLabelText('Client secret').className).toMatch(/\bw-full\b/);
  });

  it('renders a password field when secret', () => {
    renderField({ secret: true, value: '', onChange: () => {} });
    expect(screen.getByLabelText('Client secret')).toHaveAttribute('type', 'password');
  });

  it('reserves right padding and shows the adornment when one is passed', () => {
    renderField({ value: '', onChange: () => {}, adornment: <span data-testid="glyph" /> });
    expect(screen.getByTestId('glyph')).toBeInTheDocument();
    expect(screen.getByLabelText('Client secret').className).toMatch(/\bpr-9\b/);
  });

  it('wires a hint via aria-describedby', () => {
    renderField({ value: '', onChange: () => {}, hint: 'from the developer portal' });
    const input = screen.getByLabelText('Client secret');
    const hint = screen.getByText('from the developer portal');
    expect(input).toHaveAttribute('aria-describedby', hint.id);
  });

  it('marks the field invalid and announces the error', () => {
    renderField({ value: '', onChange: () => {}, error: 'Something broke' });
    const input = screen.getByLabelText('Client secret');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('alert')).toHaveTextContent('Something broke');
  });

  it('renders a reachable help affordance when a help label is given', () => {
    renderField({ value: '', onChange: () => {}, help: 'Where to find this' });
    expect(screen.getByRole('button', { name: /help: client secret/i })).toBeInTheDocument();
  });

  it('keeps the caller-supplied helpLabel as the trigger name', () => {
    renderField({ value: '', onChange: () => {}, help: 'Where to find this', helpLabel: 'Hilfe: Client secret' });
    expect(screen.getByRole('button', { name: 'Hilfe: Client secret' })).toBeInTheDocument();
  });
});

// The help "?" beside an identifier label used to be a 12x12 Radix Tooltip trigger that opened
// on hover or keyboard focus only, so a touch user had no way in (canon Tier 2: no hover-only
// reveals, tap targets >= 44px). It now rides the shared InfoTip: hover opens, a tap or
// Enter/Space pins it, Escape closes it, and the help text is the trigger's accessible
// description at all times.
describe('Field help (InfoTip)', () => {
  const HELP = 'Find the Page ID under Settings, Page transparency.';
  const trigger = () => screen.getByRole('button', { name: /help: client secret/i });
  const bubble = () => screen.queryByText(HELP, { selector: '[data-infotip-content]' });
  const withHelp = () => renderField({ value: '', onChange: () => {}, help: HELP });

  it('is the shared InfoTip trigger with the 44px tap area and the help as its description', () => {
    withHelp();
    const btn = trigger();
    expect(btn).toHaveAttribute('data-infotip');
    for (const cls of TAP_TARGET.split(/\s+/)) expect(btn).toHaveClass(cls);
    expect(btn).toHaveAccessibleDescription(HELP);
    expect(bubble()).toBeNull();
  });

  it('opens on mouse hover and closes when the pointer leaves', async () => {
    const user = userEvent.setup();
    withHelp();
    await user.hover(trigger());
    await waitFor(() => expect(bubble()).toBeInTheDocument());
    expect(screen.getByRole('tooltip')).toHaveTextContent(HELP);
    await user.unhover(trigger());
    await waitFor(() => expect(bubble()).toBeNull());
  });

  it('opens on a tap and stays open until tapped again', async () => {
    withHelp();
    fireEvent.pointerEnter(trigger(), { pointerType: 'touch' });
    expect(bubble()).toBeNull();
    fireEvent.click(trigger());
    await waitFor(() => expect(bubble()).toBeInTheDocument());
    fireEvent.click(trigger());
    await waitFor(() => expect(bubble()).toBeNull());
  });

  it('opens from the keyboard with Enter and Escape closes it, focus staying on the trigger', async () => {
    const user = userEvent.setup();
    withHelp();
    trigger().focus();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(bubble()).toBeInTheDocument());
    expect(trigger()).toHaveFocus();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(bubble()).toBeNull());
  });

  // The "?" hit box reaches 16px above the glyph. In a Setup identifier grid (gap-y-3) that is
  // ~2px past the row gap, onto the bottom edge of the PREVIOUS field's input (measured at
  // 375px by verify-p1-field-help.cjs, H2). The input box is lifted above every hit box, so
  // a tap on an input you can see always lands in that input.
  it('lifts the input box above neighbouring hit boxes so no "?" steals a tap on an input', () => {
    withHelp();
    const input = screen.getByLabelText('Client secret');
    expect(input.parentElement).toHaveClass('relative', 'z-[1]');
  });

  it('renders no help trigger without help text', () => {
    renderField({ value: '', onChange: () => {} });
    expect(screen.queryByRole('button')).toBeNull();
  });
});
