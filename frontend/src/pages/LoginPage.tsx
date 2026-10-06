import { useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '@/stores/auth';
import { api } from '@/services/api';

export function LoginPage() {
  const login = useAuth((s) => s.login);
  const nav = useNavigate();
  const loc = useLocation() as { state?: { from?: string } };
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(email, password);
      nav(loc.state?.from ?? '/', { replace: true });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-wrap">
      <form className="card login-card" onSubmit={submit}>
        <div className="card-body stack">
          <div className="row">
            <img src="/favicon.svg" width={28} height={28} alt="" />
            <div>
              <div className="brand-name">PERFMON</div>
              <div className="brand-tag">Performance Engineering. Observability. Intelligence.</div>
            </div>
          </div>
          {error && <div className="error-box" role="alert">{error}</div>}
          <div className="field">
            <label htmlFor="email">Email</label>
            <input id="email" className="input" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
          </div>
          <div className="field">
            <label htmlFor="password">Password</label>
            <input id="password" className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          </div>
          <button className="btn btn-primary" type="submit" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
          <Link to="/forgot-password" className="muted">Forgot password?</Link>
        </div>
      </form>
    </div>
  );
}

export function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  return (
    <div className="login-wrap">
      <form className="card login-card" onSubmit={async (e) => { e.preventDefault(); await api.post('/auth/forgot-password', { email }).catch(() => undefined); setSent(true); }}>
        <div className="card-body stack">
          <h2>Reset password</h2>
          {sent ? <div className="notice">If the account exists, a reset link has been sent. (Without SMTP configured, the link is written to the backend log.)</div> : (
            <>
              <div className="field"><label htmlFor="fp-email">Email</label><input id="fp-email" className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required /></div>
              <button className="btn btn-primary" type="submit">Send reset link</button>
            </>
          )}
          <Link to="/login">Back to sign in</Link>
        </div>
      </form>
    </div>
  );
}

export function ResetPasswordPage() {
  const token = new URLSearchParams(window.location.search).get('token') ?? '';
  const [password, setPassword] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  return (
    <div className="login-wrap">
      <form className="card login-card" onSubmit={async (e) => {
        e.preventDefault();
        try { await api.post('/auth/reset-password', { token, password }); setMsg({ ok: true, text: 'Password updated. You can sign in now.' }); }
        catch (err) { setMsg({ ok: false, text: (err as Error).message }); }
      }}>
        <div className="card-body stack">
          <h2>Choose a new password</h2>
          {msg && <div className={msg.ok ? 'notice' : 'error-box'}>{msg.text}</div>}
          <div className="field"><label htmlFor="np">New password (min 8 chars, letters and digits)</label><input id="np" className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} /></div>
          <button className="btn btn-primary" type="submit">Update password</button>
          <Link to="/login">Back to sign in</Link>
        </div>
      </form>
    </div>
  );
}
