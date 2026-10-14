import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { PlatformBlockers, setupLinkOffered } from '../ui.jsx';
import { I18nProvider } from '../../lib/i18n.js';

// W2 (phase 3): `setupLinkOffered` is the ONE answer to "does the Before-publishing panel
// carry a '{platform} verbinden' link for this lane?". PostDetail reads it to decide whether
// its delivery row drops its own control ("Blockiert" alone). So it must be exactly "the
// panel renders the link": if it said yes while the panel drew nothing, the row would read
// "Blockiert" with no control anywhere.

function renderBlockers(props) {
  return render(
    <I18nProvider locale="en">
      <PlatformBlockers approval="approved" showApproval={false} {...props} />
    </I18nProvider>,
  );
}

const link = () => screen.queryByRole('button', { name: 'Connect Telegram' });

const cases = [
  ['needsSetup with no problems and no warnings', { telegram: { ready: false, needsSetup: true, problems: [], warnings: [] } }],
  ['needsSetup with a problem', { telegram: { ready: false, needsSetup: true, problems: ['telegram: not connected'], warnings: [] } }],
  ['needsSetup with only a warning', { telegram: { ready: false, needsSetup: true, problems: [], warnings: ['heads up'] } }],
  ['connected, with a problem', { telegram: { ready: false, needsSetup: false, problems: ['caption too long'], warnings: [] } }],
  ['connected and clean', { telegram: { ready: true, needsSetup: false, problems: [], warnings: [] } }],
];

describe('setupLinkOffered is exactly "PlatformBlockers renders the link"', () => {
  it.each(cases)('%s', (_name, platforms) => {
    const platformValidate = { ok: true, postId: 'p1', platforms };
    const onNavigate = vi.fn();
    renderBlockers({ platformValidate, onNavigate });
    expect(Boolean(link())).toBe(setupLinkOffered(platformValidate, 'telegram', onNavigate));
  });

  it('needsSetup without problems: the link renders and opens Setup on that lane', () => {
    const platformValidate = { ok: true, postId: 'p1', platforms: { telegram: { ready: false, needsSetup: true, problems: [], warnings: [] } } };
    const onNavigate = vi.fn();
    renderBlockers({ platformValidate, onNavigate });
    expect(setupLinkOffered(platformValidate, 'telegram', onNavigate)).toBe(true);
    link().click();
    expect(onNavigate).toHaveBeenCalledWith('setup', 'telegram');
  });

  it('with nowhere to navigate there is no link and the predicate says so', () => {
    const platformValidate = { ok: true, postId: 'p1', platforms: { telegram: { ready: false, needsSetup: true, problems: [], warnings: [] } } };
    renderBlockers({ platformValidate });
    expect(link()).toBeNull();
    expect(setupLinkOffered(platformValidate, 'telegram', undefined)).toBe(false);
  });
});
