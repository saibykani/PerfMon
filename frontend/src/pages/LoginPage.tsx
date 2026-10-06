import { useMemo, useState, type FormEvent, type MouseEvent, type ReactNode } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { AlertCircle, CheckCircle2, Eye, EyeOff, Lock, Moon, ShieldCheck, Sun, Zap, Activity } from 'lucide-react';
import { useAuth } from '@/stores/auth';
import { useUi } from '@/stores/ui';
import { api, ApiError, API_BASE } from '@/services/api';
import '@/styles/login.css';

/** Turn transport/API failures into actionable messages instead of a bare status code. */
function explain(err: unknown): { title: string; detail: string } {
  if (err instanceof ApiError) {
    if (err.status === 401) return { title: 'Incorrect email or password', detail: 'Check your credentials and try again.' };
    if (err.status === 423) return { title: 'Account temporarily locked', detail: err.message };
    if (err.status === 429) return { title: 'Too many attempts', detail: 'Please wait a minute before trying again.' };
    if (err.status === 404 || err.status === 405 || err.code === 'HTTP_ERROR' || err.status >= 502)
      return { title: 'Perfmon API is not reachable', detail: `No Perfmon backend answered at ${API_BASE || window.location.origin}/api/v1. If this UI is hosted separately (e.g. Vercel), set VITE_API_BASE_URL to your backend URL and add this site to the backend's CORS_ORIGINS.` };
    if (err.status === 400) return { title: 'Check the form', detail: err.message };
    return { title: 'Sign-in failed', detail: err.message };
  }
  return { title: 'Network error', detail: `Could not contact the Perfmon API${API_BASE ? ` at ${API_BASE}` : ''}. Check that the backend is running and reachable.` };
}

/** Deterministic, realistic-looking load-test curves for the hero illustration. */
function useHeroSeries() {
  return useMemo(() => {
    const n = 48;
    const tps: number[] = [], p95: number[] = [];
    let seed = 7;
    const rnd = () => ((seed = (seed * 9301 + 49297) % 233280) / 233280);
    for (let i = 0; i < n; i++) {
      const ramp = Math.min(1, i / 14);
      tps.push(18 + 92 * ramp + (rnd() - 0.5) * 8 + (i > 30 && i < 34 ? -14 : 0));
      p95.push(70 - 18 * ramp + (rnd() - 0.5) * 6 + (i > 29 && i < 35 ? 22 : 0));
    }
    const W = 560, H = 140;
    const path = (arr: number[], max: number) => arr.map((v, i) => `${i ? 'L' : 'M'}${((i / (n - 1)) * W).toFixed(1)},${(H - (v / max) * H).toFixed(1)}`).join(' ');
    const tpsPath = path(tps, 130);
    return { W, H, tpsPath, p95Path: path(p95, 130), area: `${tpsPath} L${W},${H} L0,${H} Z` };
  }, []);
}

function AuthShell({ children }: { children: ReactNode }) {
  const { theme, toggleTheme } = useUi();
  const s = useHeroSeries();
  return (
    <div className="auth">
      <section className="auth-hero" aria-hidden="true">
        <div className="auth-brand">
          <img src="/favicon.svg" width={34} height={34} alt="" />
          <div><div className="auth-brand-name">PERFMON</div><div className="auth-brand-tag">Performance Engineering. Observability. Intelligence.</div></div>
        </div>
        <div className="auth-hero-copy">
          <span className="auth-eyebrow"><span className="pulse" /> Live performance intelligence</span>
          <h2 className="auth-title">Understand every test run <span className="grad">in ten seconds.</span></h2>
          <p className="auth-sub">Stream JMeter results, correlate infrastructure, catch regressions against your baseline and hand stakeholders a report they can trust — all traced to a single Run ID.</p>
          <div className="auth-viz">
            <div className="auth-viz-card">
              <div className="auth-viz-head"><span><b>PF-2026-10-06-000127</b> · 200 TPS Payment Load</span><span className="auth-live"><i /> LIVE</span></div>
              <svg viewBox={`0 0 ${s.W} ${s.H}`} preserveAspectRatio="none">
                <defs>
                  <linearGradient id="hero-area" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor="#2dd4bf" stopOpacity="0.32" /><stop offset="1" stopColor="#2dd4bf" stopOpacity="0" /></linearGradient>
                  <linearGradient id="hero-scan" x1="0" x2="1"><stop offset="0" stopColor="#5eead4" stopOpacity="0" /><stop offset="1" stopColor="#5eead4" stopOpacity="0.5" /></linearGradient>
                </defs>
                {[0.25, 0.5, 0.75].map((y) => <line key={y} x1="0" x2={s.W} y1={s.H * y} y2={s.H * y} stroke="rgba(255,255,255,0.07)" />)}
                <path className="auth-area" d={s.area} fill="url(#hero-area)" />
                <path className="auth-line tps" d={s.tpsPath} />
                <path className="auth-line p95" d={s.p95Path} />
                <rect className="auth-scan" x="-40" y="0" width="40" height={s.H} fill="url(#hero-scan)" />
              </svg>
              <div className="auth-legend"><span><i style={{ background: '#2dd4bf' }} />Throughput (TPS)</span><span><i style={{ background: '#93c5fd' }} />P95 latency</span></div>
            </div>
            <div className="auth-chip c1"><small>Throughput</small><strong>198.4 TPS</strong><em className="up">▲ 13.9% vs baseline</em></div>
            <div className="auth-chip c2"><small>P95</small><strong>1.24 s</strong><em className="down">▲ 18% · DB latency</em></div>
            <div className="auth-chip c3"><small>SLA compliance</small><strong>96.8%</strong><em className="up">PASS WITH WARNINGS</em></div>
          </div>
        </div>
        <div className="auth-hero-foot">
          <span><Zap size={14} /> JMeter-native ingestion</span>
          <span><Activity size={14} /> Regression &amp; bottleneck analysis</span>
          <span><ShieldCheck size={14} /> RBAC &amp; audit trail</span>
        </div>
      </section>
      <section className="auth-panel">
        <button className="btn btn-ghost icon-btn auth-theme" type="button" onClick={toggleTheme} aria-label="Toggle light/dark theme">
          {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
        </button>
        {children}
      </section>
    </div>
  );
}

function MobileBrand() {
  return (
    <div className="auth-mobile-brand">
      <img src="/favicon.svg" width={30} height={30} alt="" />
      <div><div className="auth-brand-name" style={{ fontSize: 14 }}>PERFMON</div><div className="muted" style={{ fontSize: 12 }}>Performance Engineering. Observability. Intelligence.</div></div>
    </div>
  );
}

function Alert({ title, detail, ok }: { title: string; detail?: string; ok?: boolean }) {
  return (
    <div className={`auth-alert ${ok ? 'auth-ok' : ''}`} role={ok ? 'status' : 'alert'}>
      {ok ? <CheckCircle2 size={18} /> : <AlertCircle size={18} />}
      <div><b>{title}</b>{detail}</div>
    </div>
  );
}

function rippleOn(e: MouseEvent<HTMLButtonElement>) {
  const btn = e.currentTarget;
  const r = btn.getBoundingClientRect();
  const size = Math.max(r.width, r.height);
  const span = document.createElement('span');
  span.className = 'ripple';
  span.style.cssText = `width:${size}px;height:${size}px;left:${e.clientX - r.left - size / 2}px;top:${e.clientY - r.top - size / 2}px`;
  btn.appendChild(span);
  setTimeout(() => span.remove(), 650);
}

export function LoginPage() {
  const login = useAuth((s) => s.login);
  const nav = useNavigate();
  const loc = useLocation() as { state?: { from?: string } };
  const [email, setEmail] = useState(() => { try { return localStorage.getItem('perfmon.lastEmail') ?? ''; } catch { return ''; } });
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [remember, setRemember] = useState(true);
  const [error, setError] = useState<{ title: string; detail: string } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(email.trim(), password);
      try { remember ? localStorage.setItem('perfmon.lastEmail', email.trim()) : localStorage.removeItem('perfmon.lastEmail'); } catch { /* ignore */ }
      nav(loc.state?.from ?? '/', { replace: true });
    } catch (err) {
      setError(explain(err));
      setAttempt((a) => a + 1);
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell>
      <form className="auth-form" onSubmit={submit} noValidate={false}>
        <MobileBrand />
        <h1>Welcome back</h1>
        <p className="lead">Sign in to your Perfmon workspace.</p>
        {error && <Alert key={attempt} title={error.title} detail={error.detail} />}
        <div className="fl">
          <input id="email" type="email" placeholder=" " autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus={!email} />
          <label htmlFor="email">Email address</label>
        </div>
        <div className="fl">
          <input id="password" type={show ? 'text' : 'password'} placeholder=" " autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required autoFocus={!!email} />
          <label htmlFor="password">Password</label>
          <button type="button" className="fl-icon" onClick={() => setShow((v) => !v)} aria-label={show ? 'Hide password' : 'Show password'}>
            {show ? <EyeOff size={18} /> : <Eye size={18} />}
          </button>
        </div>
        <div className="auth-row">
          <label className="auth-check"><input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} /> Remember email</label>
          <Link to="/forgot-password" className="auth-link">Forgot password?</Link>
        </div>
        <button className="auth-btn" type="submit" disabled={busy} onMouseDown={rippleOn}>
          {busy ? <><span className="spinner" />Signing in…</> : 'Sign in'}
        </button>
        <div className="auth-divider">or</div>
        <button type="button" className="auth-sso" disabled title="Single sign-on can be enabled by your administrator">
          <Lock size={16} /> Continue with SSO
        </button>
        <div className="auth-foot">
          <span>© {new Date().getFullYear()} Perfmon</span>
          <span><ShieldCheck size={12} style={{ verticalAlign: -2 }} /> Protected by role-based access control</span>
        </div>
      </form>
    </AuthShell>
  );
}

export function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <AuthShell>
      <form className="auth-form" onSubmit={async (e) => { e.preventDefault(); setBusy(true); await api.post('/auth/forgot-password', { email }).catch(() => undefined); setBusy(false); setSent(true); }}>
        <MobileBrand />
        <h1>Reset your password</h1>
        <p className="lead">Enter your account email and we'll send you a secure reset link.</p>
        {sent ? (
          <Alert ok title="Check your inbox" detail="If an account exists for that email, a reset link is on its way. It expires in 30 minutes." />
        ) : (
          <>
            <div className="fl"><input id="fp-email" type="email" placeholder=" " value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus /><label htmlFor="fp-email">Email address</label></div>
            <button className="auth-btn" type="submit" disabled={busy} onMouseDown={rippleOn}>{busy ? <><span className="spinner" />Sending…</> : 'Send reset link'}</button>
          </>
        )}
        <div className="auth-foot"><Link to="/login" className="auth-link">← Back to sign in</Link></div>
      </form>
    </AuthShell>
  );
}

export function ResetPasswordPage() {
  const token = new URLSearchParams(window.location.search).get('token') ?? '';
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; title: string; detail?: string } | null>(null);
  const strong = password.length >= 8 && /[A-Za-z]/.test(password) && /\d/.test(password);
  return (
    <AuthShell>
      <form className="auth-form" onSubmit={async (e) => {
        e.preventDefault();
        try { await api.post('/auth/reset-password', { token, password }); setMsg({ ok: true, title: 'Password updated', detail: 'You can now sign in with your new password.' }); }
        catch (err) { setMsg({ ok: false, ...explain(err) }); }
      }}>
        <MobileBrand />
        <h1>Choose a new password</h1>
        <p className="lead">At least 8 characters, with letters and digits.</p>
        {msg && <Alert ok={msg.ok} title={msg.title} detail={msg.detail} />}
        <div className="fl">
          <input id="np" type={show ? 'text' : 'password'} placeholder=" " value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} autoFocus />
          <label htmlFor="np">New password</label>
          <button type="button" className="fl-icon" onClick={() => setShow((v) => !v)} aria-label={show ? 'Hide password' : 'Show password'}>{show ? <EyeOff size={18} /> : <Eye size={18} />}</button>
        </div>
        <button className="auth-btn" type="submit" disabled={!strong} onMouseDown={rippleOn}>Update password</button>
        <div className="auth-foot"><Link to="/login" className="auth-link">← Back to sign in</Link></div>
      </form>
    </AuthShell>
  );
}
