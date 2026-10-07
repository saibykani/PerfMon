import { useEffect, useRef, useState, type FormEvent, type ReactNode, type MutableRefObject } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { AlertCircle, ArrowRight, CheckCircle2, Eye, EyeOff } from 'lucide-react';
import { useAuth } from '@/stores/auth';
import { api, ApiError, API_BASE } from '@/services/api';
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
    if (err.code === 'UNAVAILABLE') return err.message;
    if (err.status === 404 || err.status === 405 || err.code === 'HTTP_ERROR' || err.status >= 502)
      return 'The Perfmon server could not be reached. Please try again in a moment.';
    return err.message;
  }
  return 'Couldn’t reach the Perfmon server. Check your internet connection and try again.';
}

/* ------------------------------------------------------------------ Scene: throughput bars */

type Mode = 'idle' | 'busy' | 'success' | 'error';
interface SignalCtl { pulse: () => void; mode: Mode }

const BARS = 56;
/** deterministic pseudo-random so the bars have the same shape on every render */
const rnd = (i: number) => { const x = Math.sin(i * 12.9898 + 78.233) * 43758.5453; return x - Math.floor(x); };
const SKYLINE = Array.from({ length: BARS }, (_, i) => {
  const ramp = Math.min(1, i / 14);                         // ramp-up, then a steady plateau
  return { h: 0.28 + 0.55 * ramp + 0.17 * rnd(i), d: (rnd(i + 99) * 2.4).toFixed(2), s: (2.6 + rnd(i + 7) * 2.2).toFixed(2) };
});

/**
 * The backdrop reads the page's sign-in state from `ctl` without re-rendering React:
 * it mirrors ctl.mode into a data attribute that CSS animates (busy speeds the bars up,
 * success turns them green, error flashes them red) and `pulse()` brightens them as you type.
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
      <div className="glow" />
      <div className="grid-bg" />
      <div className="skyline">
        {SKYLINE.map((b, i) => <i key={i} style={{ ['--h' as any]: b.h, ['--d' as any]: `-${b.d}s`, ['--s' as any]: `${b.s}s` }} />)}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ shell */

function Shell({ children, ctl }: { children: ReactNode; ctl: MutableRefObject<SignalCtl> }) {
  const health = useQuery({
    queryKey: ['health-timed'], retry: false, refetchInterval: 20000, refetchOnWindowFocus: false,
    queryFn: async () => { const t0 = performance.now(); const r = await api.get<{ status: string }>('/health'); return { ...r, ms: Math.round(performance.now() - t0) }; },
  });
  const up = health.data?.status === 'UP';
  return (
    <div className="auth">
      <Scene ctl={ctl} />
      <header className="top">
        <div className="auth-brand"><LogoMark size={30} /><span>Perf<b>mon</b></span></div>
        <span className={`chip ${health.isError ? 'down' : up ? 'up' : ''}`} title="Measured round-trip to the Perfmon API">
          <i />{health.isLoading ? 'Checking API…' : up ? <>API <b className="num">{health.data!.ms} ms</b></> : 'API unreachable'}
        </span>
      </header>
      <WakingBanner className="auth-waking" />
      {children}
      <footer className="foot">
        <span>© {new Date().getFullYear()} Perfmon</span>
        <Link to="/help">Help &amp; documentation</Link>
        <a href={`${API_BASE}/api/docs`} target="_blank" rel="noreferrer">API docs</a>
      </footer>
    </div>
  );
}

const Mark = () => (
  <div className="hero">
    <div className="mark"><LogoMark size={76} animated /></div>
    <div className="wordmark">Perf<span>mon</span></div>
    <div className="tagline">Performance Engineering</div>
  </div>
);

/* ------------------------------------------------------------------ pages */

export function LoginPage() {
  const login = useAuth((s) => s.login);
  const nav = useNavigate();
  const loc = useLocation() as { state?: { from?: string } };
  const ctl = useRef<SignalCtl>({ pulse: () => undefined, mode: 'idle' });
  const [email, setEmail] = useState(() => { try { return localStorage.getItem('perfmon.lastEmail') ?? ''; } catch { return ''; } });
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [caps, setCaps] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errKey, setErrKey] = useState(0);
  const [state, setState] = useState<'idle' | 'busy' | 'done'>('idle');
  const cfg = useQuery({ queryKey: ['auth-config'], queryFn: () => api.get<{ demo?: { email: string; password?: string } | null }>('/auth/config'), retry: false, staleTime: Infinity });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!email.trim() || !password) { setError('Enter your email and password.'); setErrKey((k) => k + 1); ctl.current.mode = 'error'; setTimeout(() => (ctl.current.mode = 'idle'), 500); return; }
    setState('busy'); setError(null); ctl.current.mode = 'busy';
    try {
      await login(email.trim(), password);
      try { localStorage.setItem('perfmon.lastEmail', email.trim()); } catch { /* ignore */ }
      setState('done'); ctl.current.mode = 'success';
      setTimeout(() => nav(loc.state?.from ?? '/', { replace: true }), reducedMotion() ? 0 : 450);
    } catch (err) {
      setError(explain(err)); setErrKey((k) => k + 1); setState('idle');
      ctl.current.mode = 'error'; setTimeout(() => (ctl.current.mode = 'idle'), 500);
    }
  };

  const fillDemo = () => { const d = cfg.data?.demo; if (!d) return; setEmail(d.email); if (d.password) setPassword(d.password); ctl.current.pulse(); };

  return (
    <Shell ctl={ctl}>
      <form className="panel" onSubmit={submit} noValidate>
        <Mark />
        <h1 className="title">Sign in to your workspace</h1>
        {error && <div key={errKey} className="msg" role="alert"><AlertCircle size={16} />{error}</div>}
        <div className="inputs">
          <div className={`fx ${error ? 'err' : ''}`}>
            <input id="email" type="email" placeholder=" " autoComplete="username" value={email} autoFocus={!email}
              onChange={(e) => { setEmail(e.target.value); setError(null); ctl.current.pulse(); }} />
            <label htmlFor="email">Email address</label>
          </div>
          <div className={`fx ${error ? 'err' : ''}`}>
            <input id="password" type={show ? 'text' : 'password'} placeholder=" " autoComplete="current-password" value={password} autoFocus={!!email}
              onChange={(e) => { setPassword(e.target.value); setError(null); ctl.current.pulse(); }}
              onKeyDown={(e) => setCaps(e.getModifierState?.('CapsLock') ?? false)} onKeyUp={(e) => setCaps(e.getModifierState?.('CapsLock') ?? false)} />
            <label htmlFor="password">Password</label>
            <button type="button" className="fx-btn" onClick={() => setShow((v) => !v)} aria-label={show ? 'Hide password' : 'Show password'}>{show ? <EyeOff size={18} /> : <Eye size={18} />}</button>
          </div>
        </div>
        <div className="meta">
          {caps ? <span className="caps"><AlertCircle size={13} /> Caps Lock is on</span> : <span />}
          <Link to="/forgot-password">Forgot password?</Link>
        </div>
        <button className={`go ${state === 'done' ? 'ok' : ''}`} type="submit" disabled={state !== 'idle'}>
          {state === 'busy' && <span className="dots" aria-label="Signing in"><i /><i /><i /></span>}
          {state === 'done' && <><svg className="tick" width="18" height="18" viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" /></svg>Signed in</>}
          {state === 'idle' && <>Sign in <ArrowRight size={18} className="arrow" /></>}
        </button>
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
      <form className="panel" onSubmit={async (e) => { e.preventDefault(); setBusy(true); ctl.current.mode = 'busy'; await api.post('/auth/forgot-password', { email }).catch(() => undefined); setBusy(false); ctl.current.mode = 'success'; setSent(true); }}>
        <Mark />
        <h1 className="title">Reset your password</h1>
        <p className="lede">We’ll email you a secure link to choose a new one.</p>
        {sent ? <div className="msg okmsg"><CheckCircle2 size={16} />If an account exists for that email, a reset link is on its way (valid 30 minutes).</div> : (
          <>
            <div className="inputs"><div className="fx"><input id="fp" type="email" placeholder=" " value={email} onChange={(e) => { setEmail(e.target.value); ctl.current.pulse(); }} required autoFocus /><label htmlFor="fp">Email address</label></div></div>
            <div className="meta"><span /><span /></div>
            <button className="go" type="submit" disabled={busy}>{busy ? <span className="dots"><i /><i /><i /></span> : <>Send reset link <ArrowRight size={18} className="arrow" /></>}</button>
          </>
        )}
        <div className="demo"><Link to="/login" className="linkbtn">← Back to sign in</Link></div>
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
      <form className="panel" onSubmit={async (e) => {
        e.preventDefault();
        try { await api.post('/auth/reset-password', { token, password }); ctl.current.mode = 'success'; setMsg({ ok: true, text: 'Password updated — you can sign in now.' }); }
        catch (err) { ctl.current.mode = 'error'; setTimeout(() => (ctl.current.mode = 'idle'), 500); setMsg({ ok: false, text: explain(err) }); }
      }}>
        <Mark />
        <h1 className="title">Choose a new password</h1>
        <p className="lede">8+ characters with letters and numbers.</p>
        {msg && <div className={`msg ${msg.ok ? 'okmsg' : ''}`}>{msg.ok ? <CheckCircle2 size={16} /> : <AlertCircle size={16} />}{msg.text}</div>}
        <div className="inputs">
          <div className="fx">
            <input id="np" type={show ? 'text' : 'password'} placeholder=" " value={password} onChange={(e) => { setPassword(e.target.value); ctl.current.pulse(); }} required minLength={8} autoFocus />
            <label htmlFor="np">New password</label>
            <button type="button" className="fx-btn" onClick={() => setShow((v) => !v)} aria-label={show ? 'Hide password' : 'Show password'}>{show ? <EyeOff size={18} /> : <Eye size={18} />}</button>
          </div>
        </div>
        <div className="meta"><span /><span /></div>
        <button className="go" type="submit" disabled={!valid}>Save password <ArrowRight size={18} className="arrow" /></button>
        <div className="demo"><Link to="/login" className="linkbtn">← Back to sign in</Link></div>
      </form>
    </Shell>
  );
}
