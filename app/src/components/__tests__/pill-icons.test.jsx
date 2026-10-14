import { render } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { axeClean } from '../../test-utils/axe.js';
import { StatusPill, PostStatusPill, NextActorChip } from '../ui.jsx';
import { STATE_META, APPROVAL_META } from '../../lib/format.js';

const withQuery = (ui) => <QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>;

// A2 (DESIGN.md section 3): StatusPill/ApprovalPill carried meaning by color +
// text only. They now lead with a decorative (aria-hidden) lucide icon, matching
// the TimeChip's icon+tone treatment. The pills already carry their text label, so
// the icon never becomes the sole signal (WCAG 1.4.1) - it is purely coherence.

describe('StatusPill icon', () => {
  it('renders a decorative (aria-hidden) icon ahead of the label for every state', () => {
    for (const state of Object.keys(STATE_META)) {
      const { container } = render(<StatusPill state={state} />);
      const svg = container.querySelector('svg');
      expect(svg, `state "${state}" should render an icon`).not.toBeNull();
      expect(svg.getAttribute('aria-hidden')).toBe('true');
      // The text label is still present (icon is additive, not a replacement).
      expect(container.textContent.trim().length).toBeGreaterThan(0);
    }
  });

  it('keeps BOTH the icon and the text on the compact `short` pill (not icon-only)', () => {
    const { container } = render(<StatusPill state="overdue" short />);
    expect(container.querySelector('svg')).not.toBeNull();
    expect(container.textContent.trim().length).toBeGreaterThan(0);
  });
});

describe('PostStatusPill icon', () => {
  it('renders a decorative icon + label for a pending post', () => {
    const { container } = render(withQuery(<PostStatusPill post={{ approval: 'pending', derivedState: 'waiting-due', platforms: [] }} />));
    const svg = container.querySelector('svg');
    expect(svg).not.toBeNull();
    expect(svg.getAttribute('aria-hidden')).toBe('true');
    expect(container.textContent.trim().length).toBeGreaterThan(0);
  });

  // D7 (phase 3): the lane name is visible text on every surface that wears the pill, so the
  // pill itself carries no hover-only reason.
  it('a lane that is not connected reads Blocked, with no hover-only reason on the pill', () => {
    const setup = { platforms: [{ platform: 'telegram', status: 'incomplete' }] };
    const { container } = render(withQuery(<PostStatusPill post={{ approval: 'approved', derivedState: 'waiting-due', platforms: ['telegram'] }} setup={setup} />));
    expect(container.textContent).toBe('Blocked');
    expect(container.querySelector('span[title]')).toBeNull();
  });

  // Tail2 U1 (phase 3): the pill never carries the platform's raw failure line (English engine
  // text) as a hover title. Every surface wearing a failed pill says why in visible text, so
  // the pill shows only its status word.
  it.each([
    ['publish-failed', { message: 'HTTP 500 internal: re-mirror the render or set imageUrl', halted: true }],
    ['publish-needs-you', { message: 'OAuthException: token expired', recovery: 'reconnect' }],
  ])('a %s pill shows only its word, never the raw failure line as a title', (_key, lastFailure) => {
    const post = { approval: 'approved', derivedState: 'publish-failed', platforms: [], lastFailure };
    const { container } = render(withQuery(<PostStatusPill post={post} setup={{ platforms: [] }} />));
    expect(container.querySelector('span[title]')).toBeNull();
    expect(container.innerHTML).not.toContain(lastFailure.message);
    expect(container.textContent.trim().length).toBeGreaterThan(0);
  });
});

// Wave 2g F2 (canon: no hover-only reveals): the pill carries no native title at all. The
// "Du postest selbst" lane sentence and the status.tip.* buckets (scheduled, retrying,
// verify-failed) were hover-only; each surface wearing the pill says what matters in text.
describe('PostStatusPill carries no hover-only title', () => {
  const setup = { platforms: [{ platform: 'reddit', status: 'incomplete' }, { platform: 'linkedin', status: 'connected', validation: { state: 'live' } }] };
  it.each([
    ['postYourself', { approval: 'approved', derivedState: 'waiting-due', platforms: ['reddit'] }],
    ['scheduled', { approval: 'none', derivedState: 'scheduled-native', platforms: ['linkedin'] }],
    ['publish-retrying', { approval: 'approved', derivedState: 'publish-failed', platforms: ['linkedin'], lastFailure: { message: 'HTTP 500', terminal: false } }],
    ['verify-failed', { approval: 'approved', derivedState: 'verify-failed', platforms: ['linkedin'] }],
  ])('a %s pill shows only its word', (_key, post) => {
    const { container } = render(withQuery(<PostStatusPill post={post} setup={setup} />));
    expect(container.querySelector('[title]')).toBeNull();
    expect(container.textContent.trim().length).toBeGreaterThan(0);
  });
});

// Phase 3 final tail (canon: no hover-only reveals): the schedule/failure StatusPill carried a
// state.tip.* sentence as a native title, unreachable on touch and keyboard. The approval card
// and Published row open the post detail, which says what matters as visible text (delivery
// row, failure banner, Re-check, Publish now); the run-due dialog is the publish action itself.
describe('StatusPill carries no hover-only title', () => {
  it('renders no title for any state, long or short', () => {
    for (const state of Object.keys(STATE_META)) {
      for (const short of [false, true]) {
        const { container, unmount } = render(<StatusPill state={state} short={short} />);
        expect(container.querySelector('[title]'), `state "${state}" short=${short}`).toBeNull();
        expect(container.textContent.trim().length).toBeGreaterThan(0);
        unmount();
      }
    }
  });
});

// Same canon for the approval-card next-actor chip: the scheduled branch hid the full stamp
// and the auto-approve provenance in a title, the reApprove branch its auto-approve note.
describe('NextActorChip carries no hover-only title', () => {
  const at = '2026-11-02T09:30:00Z';
  it.each([
    ['scheduled (manual approval)', { approval: 'approved', derivedState: 'waiting-due', scheduledAt: at, platforms: [] }],
    ['scheduled (auto-approved)', { approval: 'approved', approvalBy: 'policy:auto-approve', derivedState: 'waiting-due', scheduledAt: at, platforms: [] }],
    ['reApprove (auto-approved)', { approval: 'approved', approvalBy: 'policy:auto-approve', editedSinceApproval: true, derivedState: 'waiting-due', scheduledAt: at, platforms: [] }],
  ])('a %s chip shows only its words', (_name, post) => {
    const { container } = render(withQuery(<NextActorChip post={post} setup={{ platforms: [] }} />));
    expect(container.querySelector('[title]')).toBeNull();
    expect(container.textContent.trim().length).toBeGreaterThan(0);
  });
});

describe('pill META icon coverage', () => {
  // lucide-react icons are forwardRef components (typeof 'object'), so the tripwire
  // asserts a defined, renderable component type rather than a plain function.
  const isComponent = (Icon) => Boolean(Icon) && ['function', 'object'].includes(typeof Icon);

  it('defines an Icon for every STATE_META entry', () => {
    for (const [state, meta] of Object.entries(STATE_META)) {
      expect(isComponent(meta.Icon), `STATE_META.${state} needs an Icon`).toBe(true);
    }
  });

  it('defines an Icon for every APPROVAL_META entry', () => {
    for (const [status, meta] of Object.entries(APPROVAL_META)) {
      expect(isComponent(meta.Icon), `APPROVAL_META.${status} needs an Icon`).toBe(true);
    }
  });
});

describe('pill accessibility', () => {
  it('has no axe violations with the icon present', async () => {
    const { container } = render(
      <div>
        <StatusPill state="posted" />
        <StatusPill state="overdue" short />
        {withQuery(<PostStatusPill post={{ approval: 'pending', derivedState: 'waiting-due', platforms: [] }} />)}
      </div>,
    );
    expect(await axeClean(container)).toHaveNoViolations();
  });
});
