import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import ActionButton from '../ActionButton.jsx';

// ActionButton hands the caller the thrown error's message through onError. A failure that
// carries no message used to hand over the literal English 'Error', which then showed as the
// detail behind the "?" on the profile edit panel. With no message there is nothing to show:
// onError still fires (so the caller can say its own plain sentence) but with null.

const labels = { idle: 'Apply', loading: 'Applying', success: 'Applied', error: 'Could not apply' };

describe('ActionButton onError', () => {
  it('hands over the thrown message when there is one', async () => {
    const onError = vi.fn();
    const user = userEvent.setup();
    render(<ActionButton labels={labels} onAction={() => Promise.reject(new Error('server said no'))} onError={onError} />);
    await user.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(onError).toHaveBeenCalledWith('server said no'));
  });

  it('a failure with no message fires onError with null, never the literal "Error"', async () => {
    const onError = vi.fn();
    const user = userEvent.setup();
    render(<ActionButton labels={labels} onAction={() => Promise.reject(new Error(''))} onError={onError} />);
    await user.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    expect(onError).toHaveBeenCalledWith(null);
    expect(screen.getByRole('button', { name: 'Could not apply' })).toBeInTheDocument();
  });

  it('a user cancel stays silent', async () => {
    const onError = vi.fn();
    const user = userEvent.setup();
    render(<ActionButton labels={labels} onAction={() => Promise.reject(Object.assign(new Error('x'), { canceled: true }))} onError={onError} />);
    await user.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Apply' })).not.toBeDisabled());
    expect(onError).not.toHaveBeenCalled();
  });
});
