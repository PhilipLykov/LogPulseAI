import { useState } from 'react';
import { login, setSessionToken, setStoredUser, changePassword } from '../api';
import type { CurrentUser } from '../api';

interface LoginFormProps {
  onLogin: (user: CurrentUser) => void;
}

export function LoginForm({ onLogin }: LoginFormProps) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // Password change flow (for must_change_password)
  const [mustChange, setMustChange] = useState(false);
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [changingPw, setChangingPw] = useState(false);
  const [pendingUser, setPendingUser] = useState<CurrentUser | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedUser = username.trim();
    if (!trimmedUser || !password) return;

    setError('');
    setSubmitting(true);

    try {
      const result = await login(trimmedUser, password);
      setSessionToken(result.token);
      setStoredUser(result.user);

      if (result.user.must_change_password) {
        setPendingUser(result.user);
        setMustChange(true);
      } else {
        onLogin(result.user);
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message || 'Login failed.');
    } finally {
      setSubmitting(false);
    }
  };

  const handlePasswordChange = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newPassword || !confirmPassword) return;

    if (newPassword !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }

    setError('');
    setChangingPw(true);

    try {
      await changePassword(password, newPassword);
      if (pendingUser) {
        const updated = { ...pendingUser, must_change_password: false };
        setStoredUser(updated);
        onLogin(updated);
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message || 'Password change failed.');
    } finally {
      setChangingPw(false);
    }
  };

  if (mustChange) {
    return (
      <div className="login-container">
        <form className="login-card" onSubmit={handlePasswordChange}>
          <h2>Change Password</h2>
          <p className="login-subtitle">
            You must change your password before continuing.
          </p>

          {error && <div id="login-error-msg" className="login-error" role="alert">{error}</div>}

          <label htmlFor="new-pw-input" className="sr-only">New Password</label>
          <input
            id="new-pw-input"
            name="new-password"
            type="password"
            placeholder="New Password (min 12 chars)"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            autoFocus
            autoComplete="new-password"
            minLength={12}
          />

          <label htmlFor="confirm-pw-input" className="sr-only">Confirm Password</label>
          <input
            id="confirm-pw-input"
            name="confirm-password"
            type="password"
            placeholder="Confirm New Password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            autoComplete="new-password"
            minLength={12}
          />

          <p className="form-hint" style={{ fontSize: '0.8em', color: 'var(--muted)', marginTop: 0 }}>
            Min 12 characters, 1 uppercase, 1 lowercase, 1 digit, 1 special character.
          </p>

          <button type="submit" className="btn" disabled={changingPw || !newPassword || !confirmPassword}>
            {changingPw ? 'Changing…' : 'Change Password'}
          </button>
        </form>
      </div>
    );
  }

  return (
    <div className="login-container">
      <form className="login-card" onSubmit={handleSubmit}>
        <h2>LogPulse AI</h2>
        <p className="login-subtitle">
          Sign in with your username and password.
        </p>

        {error && <div id="login-error-msg" className="login-error" role="alert">{error}</div>}

        <label htmlFor="username-input" className="sr-only">Username</label>
        <input
          id="username-input"
          name="username"
          type="text"
          placeholder="Username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          autoFocus
          autoComplete="username"
          aria-describedby={error ? 'login-error-msg' : undefined}
        />

        <label htmlFor="password-input" className="sr-only">Password</label>
        <input
          id="password-input"
          name="password"
          type="password"
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
        />

        <button type="submit" className="btn" disabled={submitting || !username.trim() || !password}>
          {submitting ? 'Signing in…' : 'Sign In'}
        </button>
      </form>
    </div>
  );
}
