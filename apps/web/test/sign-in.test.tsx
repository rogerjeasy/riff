// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SignIn } from '../src/console/sign-in.js';
import { api, ApiError } from '../src/lib/api.js';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it('signs in with the password and hands over once a session exists', async () => {
  const login = vi.spyOn(api, 'login').mockResolvedValue({ authenticated: true });
  const signedIn = vi.fn();
  render(<SignIn onSignedIn={signedIn} />);
  const submit = screen.getByRole('button', { name: 'Sign in' }) as HTMLButtonElement;
  expect(submit.disabled).toBe(true);
  const field = screen.getByLabelText('Password') as HTMLInputElement;
  expect(field.type).toBe('password');
  expect(field.autocomplete).toBe('current-password');
  fireEvent.click(screen.getByRole('button', { name: 'Show' }));
  expect(field.type).toBe('text');
  fireEvent.change(field, { target: { value: 'correct-horse-battery' } });
  fireEvent.click(submit);
  await waitFor(() => expect(signedIn).toHaveBeenCalled());
  expect(login).toHaveBeenCalledWith('correct-horse-battery');
});

it('explains a wrong password and keeps the form usable', async () => {
  vi.spyOn(api, 'login').mockRejectedValue(
    new ApiError('That password isn’t right. Check it and try again.', 401, 'INVALID_PASSWORD'),
  );
  const signedIn = vi.fn();
  render(<SignIn onSignedIn={signedIn} />);
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'nope' } });
  fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
  expect((await screen.findByRole('alert')).textContent).toMatch(/isn’t right/);
  expect(screen.getByLabelText('Password').getAttribute('aria-invalid')).toBe('true');
  expect((screen.getByRole('button', { name: 'Sign in' }) as HTMLButtonElement).disabled).toBe(
    false,
  );
  expect(signedIn).not.toHaveBeenCalled();
});

it('says the studio is unreachable when the request never arrives', async () => {
  vi.spyOn(api, 'login').mockRejectedValue(new ApiError('offline', 0, 'OFFLINE'));
  render(<SignIn onSignedIn={vi.fn()} />);
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'whatever' } });
  fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
  expect((await screen.findByRole('alert')).textContent).toMatch(/Couldn’t reach your studio/);
});
