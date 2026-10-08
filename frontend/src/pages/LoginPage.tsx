import { useEffect, useRef, useState, type FormEvent, type ReactNode, type MutableRefObject } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Activity, AlertCircle, ArrowRight, CheckCircle2, Cpu, Eye, EyeOff, Gauge, Lock, Mail, MemoryStick, ShieldCheck, TriangleAlert, Users } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useAuth } from '@/stores/auth';
import { api, ApiError, API_BASE, onApiWaking } from '@/services/api';
import { LogoMark } from '@/components/Logo';
import { WakingBanner } from '@/components/WakingBanner';
import '@/styles/login.css';

const reducedMotion = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/** Turn transport/API failures into actionable messages instead of a bare status code. */
function explain(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 401) return 'That email and password don’t match. Try again or reset your password.';
    if (err.status === 423) return err.message;
    if (err.status === 429) return 'Too many attempts — please wait a minute and try again.';
    if (err.code === 'UNAVAILABLE' || err.code === 'NO_ACCOUNT') return err.message;
    if (err.status === 404 || err.status === 405 || err.code === 'HTTP_ERROR' || err.status >= 502)
      return 'The Perfmon server could not be reached. Please try again in a moment.';
    return err.message;
  }
  return 'Couldn’t reach the Perfmon server. Check your internet connection and try again.';
}

/* ------------------------------------------------------------------ scene */

type Mode = 'idle' | 'busy' | 'success' | 'error';
interface SignalCtl { pulse: () => void; mode: Mode }

/** deterministic pseudo-random so the scene looks the same on every render */
const rnd = (i: number) => { const x = Math.sin(i * 12.9898 + 78.233) * 43758.5453; return x - Math.floor(x); };

/** Star field as box-shadows (one element per layer — cheap to draw and to twinkle). */
const stars = (n: number, seed: number, alpha: number) => Array.from({ length: n }, (_, i) => {
  const x = (rnd(i + seed) * 100).toFixed(2);
  const y = (rnd(i * 7 + seed) * 100).toFixed(2);
  const a = (alpha * (0.35 + 0.65 * rnd(i * 3 + seed))).toFixed(2);
  return `${x}vw ${y}vh 0 0 rgba(230,255,245,${a})`;
}).join(',');
const STARS = [stars(160, 1, 0.55), stars(70, 50, 0.8), stars(28, 90, 1)];

/** Flowing light ribbons: many thin sine lines that drift (two periods → seamless translate loop). */
function ribbonPath(k: number, w = 1600, h = 420) {
  const pts: string[] = [];
  const amp = 46 + k * 3.2;
  const phase = k * 0.21;
  for (let x = 0; x <= w * 2; x += 20) {
    const u = x / w;
    const y = h * 0.55 + Math.sin(u * Math.PI * 2 + phase) * amp + Math.sin(u * Math.PI * 4 + phase * 1.7) * amp * 0.28 - k * 4;
    pts.push(`${x},${y.toFixed(1)}`);
  }
  return `M${pts.join(' L')}`;
}
const RIBBONS = Array.from({ length: 22 }, (_, k) => ribbonPath(k));

/** Shape of a sparkline (0..1 values) → SVG path in a w×h box. */
function spark(seed: number, n: number, w: number, h: number, trend = 0) {
  return 'M' + Array.from({ length: n }, (_, i) => {
    const v = 0.5 + 0.28 * Math.sin(i * 0.55 + seed) + 0.18 * (rnd(i + seed * 13) - 0.5) + trend * (i / n - 0.5);
    return `${((i / (n - 1)) * w).toFixed(1)},${(h - Math.max(0.05, Math.min(0.95, v)) * h).toFixed(1)}`;
  }).join(' L');
}

interface Widget { key: string; icon: LucideIcon; label: string; value: string; unit?: string; delta?: string; good?: boolean; kind: 'bars' | 'line'; seed: number; trend?: number }
const WIDGETS: Widget[] = [
  { key: 'tps', icon: Activity, label: 'Throughput', value: '248', unit: 'req/s', delta: '12%', good: true, kind: 'bars', seed: 1, trend: 0.5 },
  { key: 'p95', icon: Gauge, label: 'P95 response time', value: '812', unit: 'ms', delta: '18%', good: true, kind: 'line', seed: 4, trend: 0.3 },
  { key: 'err', icon: TriangleAlert, label: 'Error rate', value: '0.42', unit: '%', delta: '35%', good: true, kind: 'line', seed: 7 },
  { key: 'users', icon: Users, label: 'Active users', value: '1,250', delta: '18%', good: true, kind: 'bars', seed: 9, trend: 0.6 },
  { key: 'cpu', icon: Cpu, label: 'CPU', value: '62', unit: '%', kind: 'line', seed: 2, trend: 0.4 },
  { key: 'mem', icon: MemoryStick, label: 'Memory', value: '74', unit: '%', kind: 'line', seed: 5, trend: 0.2 },
  { key: 'sla', icon: ShieldCheck, label: 'SLA compliance', value: '98.6', unit: '%', kind: 'line', seed: 3, trend: 0.3 },
];

function MetricWidget({ w }: { w: Widget }) {
  return (
    <div className={`mw mw-${w.key}`}>
      <div className="mw-head"><w.icon size={13} strokeWidth={1.6} /><span>{w.label}</span></div>
      <div className="mw-val num">{w.value}{w.unit && <em>{w.unit}</em>}{w.delta && <i className={w.good ? 'up' : 'down'}>{w.good ? '↑' : '↓'} {w.delta}</i>}</div>
      {w.kind === 'bars' ? (
        <div className="mw-bars">{Array.from({ length: 22 }, (_, i) => <b key={i} style={{ height: `${Math.round(18 + 70 * Math.min(1, 0.25 + 0.45 * rnd(i + w.seed * 5) + (w.trend ?? 0) * (i / 22)))}%`, animationDelay: `${(-rnd(i + 3) * 3).toFixed(2)}s` }} />)}</div>
      ) : (
        <svg className="mw-line" viewBox="0 0 160 36" preserveAspectRatio="none"><path d={spark(w.seed, 26, 160, 36, w.trend ?? 0)} /></svg>
      )}
    </div>
  );
}

/**
 * Backdrop: star field, mint light ribbons and a soft nebula. Reads the page's sign-in state
 * from `ctl` without re-rendering React (busy → faster flow, success → brighter, error → red tint);
 * `pulse()` brightens the ribbons as you type.
 */
function Scene({ ctl }: { ctl: MutableRefObject<SignalCtl> }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current!;
    let pulseTimer: number | undefined;
    ctl.current.pulse = () => {
      el.dataset.pulse = '1';
      window.clearTimeout(pulseTimer);
      pulseTimer = window.setTimeout(() => { delete el.dataset.pulse; }, 220);
    };
    const t = window.setInterval(() => { if (el.dataset.mode !== ctl.current.mode) el.dataset.mode = ctl.current.mode; }, 90);
    return () => { window.clearInterval(t); window.clearTimeout(pulseTimer); };
  }, [ctl]);
  return (
    <div ref={ref} className="scene" data-mode="idle" aria-hidden="true">
      <div className="nebula" />
      {STARS.map((s, i) => <div key={i} className={`stars s${i}`} style={{ boxShadow: s }} />)}
      <svg className="ribbons" viewBox="0 0 1600 420" preserveAspectRatio="none">
        <defs>
          <linearGradient id="rb" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stopColor="#34d399" stopOpacity="0" />
            <stop offset=".2" stopColor="#6ee7b7" stopOpacity=".55" />
            <stop offset=".5" stopColor="#d1fae5" stopOpacity=".9" />
            <stop offset=".8" stopColor="#6ee7b7" stopOpacity=".55" />
            <stop offset="1" stopColor="#34d399" stopOpacity="0" />
          </linearGradient>
        </defs>
        <g className="rb-move">{RIBBONS.map((d, k) => <path key={k} d={d} stroke="url(#rb)" style={{ opacity: 0.12 + 0.5 * Math.sin((k / RIBBONS.length) * Math.PI) }} />)}</g>
      </svg>
      <div className="widgets">
        {WIDGETS.map((w) => <MetricWidget key={w.key} w={w} />)}
        <span className="mw-note">Sample metrics</span>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ shell */

function Shell({ children, ctl }: { children: ReactNode; ctl: MutableRefObject<SignalCtl> }) {
  const health = useQuery({
    queryKey: ['health-timed'], retry: false, refetchInterval: 30000, refetchOnWindowFocus: false,
    queryFn: async () => { const t0 = performance.now(); const r = await api.get<{ status: string }>('/health'); return { ...r, ms: Math.round(performance.now() - t0) }; },
  });
  const up = health.data?.status === 'UP';
  return (
    <div className="auth">
      <Scene ctl={ctl} />
      <WakingBanner className="auth-waking" />
      <div className="auth-grid">
        <section className="brand-side">
          <LogoMark size={104} animated />
          <div className="auth-name">Perfmon<sup>™</sup></div>
          <p className="brand-lead">Performance Engineering for<br />Smarter Digital Systems</p>
          <p className="brand-sub">Test. Observe. Optimize. Deliver better performance at scale with real-time insights.</p>
          <hr />
          <div className="brand-pillars">Performance <i /> Observability <i /> Intelligence</div>
        </section>
        <section className="auth-side">
          <div className="auth-card">
            {children}
            <footer className="auth-foot">
              <Link to="/help">Help</Link><span>|</span>
              <a href={`${API_BASE}/api/docs`} target="_blank" rel="noreferrer">API docs</a><span>|</span>
              <span className={`api ${health.isError ? 'down' : up ? 'up' : ''}`} title="Measured round-trip to the Perfmon API">
                <i />{health.isLoading ? 'Connecting…' : up ? `API ${health.data!.ms} ms` : 'Connecting…'}
              </span>
            </footer>
          </div>
        </section>
      </div>
    </div>
  );
}

const CardHead = ({ title, sub }: { title: string; sub: ReactNode }) => (
  <div className="auth-head">
    <div className="auth-logo"><LogoMark size={40} /><span>Perfmon<sup>™</sup></span></div>
    <h1>{title}</h1>
    <p>{sub}</p>
  </div>
);

/* ------------------------------------------------------------------ Google sign-in (optional) */

declare global { interface Window { google?: any } }

/**
 * Renders Google's own "Continue with Google" button (Google Identity Services) when the
 * server has GOOGLE_CLIENT_ID configured. Only existing Perfmon users can sign in this way.
 */
function GoogleButton({ clientId, onCredential }: { clientId: string; onCredential: (credential: string) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const cb = useRef(onCredential);
  cb.current = onCredential;
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    const render = () => {
      if (cancelled || !ref.current || !window.google?.accounts?.id) return;
      window.google.accounts.id.initialize({ client_id: clientId, callback: (r: { credential: string }) => cb.current(r.credential), ux_mode: 'popup' });
      window.google.accounts.id.renderButton(ref.current, { theme: 'filled_black', size: 'large', shape: 'pill', text: 'continue_with', width: ref.current.clientWidth || 356, logo_alignment: 'center' });
    };
    if (window.google?.accounts?.id) render();
    else {
      let s = document.getElementById('gsi-client') as HTMLScriptElement | null;
      if (!s) { s = document.createElement('script'); s.id = 'gsi-client'; s.src = 'https://accounts.google.com/gsi/client'; s.async = true; document.head.appendChild(s); }
      s.addEventListener('load', render);
      s.addEventListener('error', () => setFailed(true));
    }
    return () => { cancelled = true; };
  }, [clientId]);
  if (failed) return null;
  return <><div ref={ref} className="google-btn" /><div className="or"><span>or use email</span></div></>;
}

/* ------------------------------------------------------------------ pages */

export function LoginPage() {
  const login = useAuth((s) => s.login);
  const loginWithGoogle = useAuth((s) => s.loginWithGoogle);
  const nav = useNavigate();
  const loc = useLocation() as { state?: { from?: string } };
  const ctl = useRef<SignalCtl>({ pulse: () => undefined, mode: 'idle' });
  const [email, setEmail] = useState(() => { try { return localStorage.getItem('perfmon.lastEmail') ?? ''; } catch { return ''; } });
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(() => { try { return localStorage.getItem('perfmon.remember') === '1'; } catch { return false; } });
  const [show, setShow] = useState(false);
  const [caps, setCaps] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errKey, setErrKey] = useState(0);
  const [state, setState] = useState<'idle' | 'busy' | 'done'>('idle');
  const [waking, setWaking] = useState(false);
  useEffect(() => onApiWaking(setWaking), []);
  const cfg = useQuery({ queryKey: ['auth-config'], queryFn: () => api.get<{ demo?: { email: string; password?: string } | null; googleClientId?: string | null }>('/auth/config'), retry: false, staleTime: Infinity });

  const fail = (err: unknown) => {
    setError(explain(err)); setErrKey((k) => k + 1); setState('idle');
    ctl.current.mode = 'error'; setTimeout(() => (ctl.current.mode = 'idle'), 600);
  };
  const done = () => {
    try { localStorage.setItem('perfmon.remember', remember ? '1' : '0'); } catch { /* ignore */ }
    setState('done'); ctl.current.mode = 'success';
    setTimeout(() => nav(loc.state?.from ?? '/', { replace: true }), reducedMotion() ? 0 : 450);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!email.trim() || !password) { fail(new Error('Enter your email and password.')); setError('Enter your email and password.'); return; }
    setState('busy'); setError(null); ctl.current.mode = 'busy';
    try {
      await login(email.trim(), password, remember);
      try { localStorage.setItem('perfmon.lastEmail', email.trim()); } catch { /* ignore */ }
      done();
    } catch (err) { fail(err); }
  };
  const google = async (credential: string) => {
    setState('busy'); setError(null); ctl.current.mode = 'busy';
    try { await loginWithGoogle(credential, remember); done(); } catch (err) { fail(err); }
  };
  const fillDemo = () => { const d = cfg.data?.demo; if (!d) return; setEmail(d.email); if (d.password) setPassword(d.password); ctl.current.pulse(); };

  return (
    <Shell ctl={ctl}>
      <form className="auth-panel" onSubmit={submit} noValidate>
        <CardHead title="Welcome back" sub="Sign in to continue to Perfmon" />
        {cfg.data?.googleClientId && <GoogleButton clientId={cfg.data.googleClientId} onCredential={google} />}
        {error && <div key={errKey} className="auth-msg" role="alert"><AlertCircle size={16} />{error}</div>}
        <div className="inputs">
          <label className={`fx ${error ? 'err' : ''}`}>
            <Mail size={17} strokeWidth={1.7} />
            <input id="email" type="email" placeholder="Email address" autoComplete="username" value={email} autoFocus={!email}
              onChange={(e) => { setEmail(e.target.value); setError(null); ctl.current.pulse(); }} aria-label="Email address" />
          </label>
          <label className={`fx ${error ? 'err' : ''}`}>
            <Lock size={17} strokeWidth={1.7} />
            <input id="password" type={show ? 'text' : 'password'} placeholder="Password" autoComplete="current-password" value={password} autoFocus={!!email}
              onChange={(e) => { setPassword(e.target.value); setError(null); ctl.current.pulse(); }} aria-label="Password"
              onKeyDown={(e) => setCaps(e.getModifierState?.('CapsLock') ?? false)} onKeyUp={(e) => setCaps(e.getModifierState?.('CapsLock') ?? false)} />
            <button type="button" className="fx-btn" onClick={() => setShow((v) => !v)} aria-label={show ? 'Hide password' : 'Show password'}>{show ? <EyeOff size={17} /> : <Eye size={17} />}</button>
          </label>
        </div>
        {caps && <div className="caps"><AlertCircle size={13} /> Caps Lock is on</div>}
        <button className={`go ${state === 'done' ? 'ok' : ''}`} type="submit" disabled={state !== 'idle'}>
          {state === 'busy' && <><span className="dots" aria-hidden="true"><i /><i /><i /></span>{waking ? 'Connecting…' : 'Signing in…'}</>}
          {state === 'done' && <><svg className="tick" width="18" height="18" viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5" fill="none" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" /></svg>Signed in</>}
          {state === 'idle' && <>Sign in <ArrowRight size={17} className="arrow" /></>}
        </button>
        <div className="meta">
          <label className="check"><input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} /><span />Keep me signed in</label>
          <Link to="/forgot-password">Forgot password?</Link>
        </div>
        {cfg.data?.demo && <div className="demo">Exploring? <button type="button" onClick={fillDemo}>Use the demo account</button></div>}
      </form>
    </Shell>
  );
}

export function ForgotPasswordPage() {
  const ctl = useRef<SignalCtl>({ pulse: () => undefined, mode: 'idle' });
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <Shell ctl={ctl}>
      <form className="auth-panel" onSubmit={async (e) => { e.preventDefault(); setBusy(true); ctl.current.mode = 'busy'; await api.post('/auth/forgot-password', { email }).catch(() => undefined); setBusy(false); ctl.current.mode = 'success'; setSent(true); }}>
        <CardHead title="Reset password" sub="We’ll email you a secure link to choose a new one." />
        {sent ? <div className="auth-msg okmsg"><CheckCircle2 size={16} />If an account exists for that email, a reset link is on its way (valid 30 minutes).</div> : (
          <>
            <div className="inputs"><label className="fx"><Mail size={17} strokeWidth={1.7} /><input id="fp" type="email" placeholder="Email address" aria-label="Email address" value={email} onChange={(e) => { setEmail(e.target.value); ctl.current.pulse(); }} required autoFocus /></label></div>
            <button className="go" type="submit" disabled={busy}>{busy ? <span className="dots"><i /><i /><i /></span> : <>Send reset link <ArrowRight size={17} className="arrow" /></>}</button>
          </>
        )}
        <div className="meta center"><Link to="/login">← Back to sign in</Link></div>
      </form>
    </Shell>
  );
}

export function ResetPasswordPage() {
  const ctl = useRef<SignalCtl>({ pulse: () => undefined, mode: 'idle' });
  const token = new URLSearchParams(window.location.search).get('token') ?? '';
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const valid = password.length >= 8 && /[A-Za-z]/.test(password) && /\d/.test(password);
  return (
    <Shell ctl={ctl}>
      <form className="auth-panel" onSubmit={async (e) => {
        e.preventDefault();
        try { await api.post('/auth/reset-password', { token, password }); ctl.current.mode = 'success'; setMsg({ ok: true, text: 'Password updated — you can sign in now.' }); }
        catch (err) { ctl.current.mode = 'error'; setTimeout(() => (ctl.current.mode = 'idle'), 600); setMsg({ ok: false, text: explain(err) }); }
      }}>
        <CardHead title="New password" sub="8+ characters with letters and numbers." />
        {msg && <div className={`auth-msg ${msg.ok ? 'okmsg' : ''}`}>{msg.ok ? <CheckCircle2 size={16} /> : <AlertCircle size={16} />}{msg.text}</div>}
        <div className="inputs">
          <label className="fx">
            <Lock size={17} strokeWidth={1.7} />
            <input id="np" type={show ? 'text' : 'password'} placeholder="New password" aria-label="New password" value={password} onChange={(e) => { setPassword(e.target.value); ctl.current.pulse(); }} required minLength={8} autoFocus />
            <button type="button" className="fx-btn" onClick={() => setShow((v) => !v)} aria-label={show ? 'Hide password' : 'Show password'}>{show ? <EyeOff size={17} /> : <Eye size={17} />}</button>
          </label>
        </div>
        <button className="go" type="submit" disabled={!valid}>Save password <ArrowRight size={17} className="arrow" /></button>
        <div className="meta center"><Link to="/login">← Back to sign in</Link></div>
      </form>
    </Shell>
  );
}
