import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import LinkCaptureRow from '../ui/LinkCaptureRow.jsx';

// The row's error line is announced: a screen reader hears it the moment it appears
// (role="alert"), whether the caller hands over a plain string or a node carrying the
// house "?" beside the sentence.
const props = { value: '', onChange: vi.fn(), onSave: vi.fn(), placeholder: 'https://...', label: 'Posted' };

describe('LinkCaptureRow error line', () => {
  it('a string error is an alert', () => {
    render(<LinkCaptureRow {...props} error="Could not record this. Please try again." />);
    expect(screen.getByRole('alert')).toHaveTextContent('Could not record this. Please try again.');
  });

  it('a node error is one alert too', () => {
    render(<LinkCaptureRow {...props} error={<span>Plain sentence</span>} />);
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    expect(screen.getByRole('alert')).toHaveTextContent('Plain sentence');
  });

  it('a { text, raw } alert announces the sentence only; the raw line is the "?" description', () => {
    render(<LinkCaptureRow {...props} error={{ text: 'Could not record this. Please try again.', raw: 'HTTP 500 internal' }} />);
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Could not record this. Please try again.');
    expect(alert).not.toHaveTextContent(/HTTP 500/);
    expect(screen.getByRole('button', { name: /more about this/i })).toHaveAccessibleDescription('HTTP 500 internal');
  });

  it('no error, no alert', () => {
    render(<LinkCaptureRow {...props} />);
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
