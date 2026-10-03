import { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth.tsx';
import { Logo } from '../components/Logo.tsx';

export function AuthPage({ mode }: { mode: 'login' | 'register' }) {
  const auth = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const isLogin = mode === 'login';

  const submit = async () => {
    setError(null);
    if (!isLogin && password !== confirm) return setError('Passwords do not match.');
    setBusy(true);
    try {
      if (isLogin) await auth.login(email, password);
      else await auth.register(email, password);
      const from = (location.state as { from?: string } | null)?.from;
      navigate(from && from !== '/login' ? from : '/', { replace: true });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <div className="auth-page">
      <form
        className="auth-card"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className="auth-brand">
          <Logo size={36} />
          <span>Sheets</span>
        </div>
        <h1>{isLogin ? 'Sign in' : 'Create your account'}</h1>
        <label className="field">
          <span>Email</span>
          <input type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
        </label>
        <label className="field">
          <span>Password</span>
          <input
            type="password"
            autoComplete={isLogin ? 'current-password' : 'new-password'}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            minLength={isLogin ? undefined : 8}
            required
          />
        </label>
        {!isLogin && (
          <label className="field">
            <span>Confirm password</span>
            <input type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
          </label>
        )}
        {!isLogin && <div className="field-hint">At least 8 characters.</div>}
        {error && <div className="form-error">{error}</div>}
        <button type="submit" className="btn primary wide" disabled={busy}>
          {busy ? 'Please wait…' : isLogin ? 'Sign in' : 'Create account'}
        </button>
        <div className="auth-switch">
          {isLogin ? (
            <>
              New here? <Link to="/register">Create an account</Link>
            </>
          ) : (
            <>
              Already have an account? <Link to="/login">Sign in</Link>
            </>
          )}
        </div>
      </form>
      {isLogin && (
        <figure className="auth-diagram">
          <img src="/architecture.png" alt="How Sheets works: the browser talks to a live agent on the server; the live agent files app change jobs with a coding agent that edits the app's source, restarts it and publishes a merged pull request." width="820" height="470" />
          <figcaption>Sheets improves itself: ask the assistant for something it can't do, and a coding agent adds it to the app.</figcaption>
        </figure>
      )}
    </div>
  );
}
