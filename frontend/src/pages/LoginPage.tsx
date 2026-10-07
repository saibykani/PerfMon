import { useEffect, useRef, useState, type FormEvent, type ReactNode, type MutableRefObject } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { AlertCircle, ArrowRight, CheckCircle2, Eye, EyeOff, Moon, Sun } from 'lucide-react';
import { useAuth } from '@/stores/auth';
import { useUi } from '@/stores/ui';
import { api, ApiError, API_BASE } from '@/services/api';
import { LogoMark } from '@/components/Logo';
import '@/styles/login.css';

const reducedMotion = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/** Turn transport/API failures into actionable messages instead of a bare status code. */
function explain(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 401) return 'That email and password don’t match. Try again or reset your password.';
    if (err.status === 423) return err.message;
    if (err.status === 429) return 'Too many attempts — please wait a minute and try again.';
    if (err.status === 404 || err.status === 405 || err.code === 'HTTP_ERROR' || err.status >= 502)
      return `The Perfmon API isn’t reachable at ${API_BASE || window.location.origin}/api/v1. Check that the backend is running.`;
    return err.message;
  }
  return 'Couldn’t reach the Perfmon API. Check your connection and that the backend is running.';
}

/* ------------------------------------------------------------------ Signal: interactive wave field */

type Mode = 'idle' | 'busy' | 'success' | 'error';
interface SignalCtl { pulse: () => void; mode: Mode }

const PALETTE = {
  dark: [[167, 139, 250], [96, 165, 250], [45, 212, 191], [244, 114, 182]],
  light: [[124, 58, 237], [59, 130, 246], [13, 148, 136], [219, 39, 119]],
};

function Signal({ ctl, theme }: { ctl: MutableRefObject<SignalCtl>; theme: 'light' | 'dark' }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current!;
    const ctx = c.getContext('2d')!;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    let W = 0, H = 0, raf = 0;
    const mouse = { x: -9999, y: -9999, tx: -9999, ty: -9999 };
    const resize = () => { W = c.clientWidth; H = c.clientHeight; c.width = W * dpr; c.height = H * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0); };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(c);
    const onMove = (e: MouseEvent) => { mouse.tx = e.clientX; mouse.ty = e.clientY; };
    const onLeave = () => { mouse.tx = -9999; mouse.ty = -9999; };
    window.addEventListener('mousemove', onMove);
    document.addEventListener('mouseleave', onLeave);

    const RIBBONS = 24;
    const sparks = Array.from({ length: 26 }, (_, i) => ({ r: i % RIBBONS, u: Math.random(), v: 0.0006 + Math.random() * 0.0016 }));
    let t = 0, energy = 0, amp = 1, flash = 0, speed = 1, green = 0;
    let lastPulse = 0;
    ctl.current.pulse = () => { energy = Math.min(1, energy + 0.22); lastPulse = performance.now(); };

    const pal = PALETTE[theme];
    const yAt = (i: number, x: number) => {
      const nx = x / W;
      const base = H * 0.56 + (i - RIBBONS / 2) * (H * 0.011);
      const a = H * 0.13 * amp * (1 + energy * 0.9);
      const w = Math.sin(nx * 5.2 + t * 0.9 + i * 0.16) * 0.55 + Math.sin(nx * 9.5 - t * 1.3 + i * 0.09) * 0.28 + Math.sin(nx * 2.1 + t * 0.4 - i * 0.05) * 0.5;
      let y = base + a * w * (0.65 + 0.35 * Math.sin(i * 0.4 + t * 0.2));
      // cursor bends the field
      const dx = x - mouse.x, dy = y - mouse.y;
      const d2 = dx * dx + dy * dy;
      if (d2 < 90000) y += 64 * Math.tanh(dy / 38) * Math.exp(-(dx * dx) / 22000) * Math.exp(-(dy * dy) / 30000) * amp;
      return y;
    };

    const frame = () => {
      const mode = ctl.current.mode;
      const targetSpeed = mode === 'busy' ? 3.2 : 1;
      speed += (targetSpeed - speed) * 0.05;
      amp += ((mode === 'success' ? 0.02 : 1) - amp) * (mode === 'success' ? 0.06 : 0.04);
      green += ((mode === 'success' ? 1 : 0) - green) * 0.05;
      if (mode === 'error' && flash < 0.05) flash = 1;
      flash *= 0.94;
      energy *= performance.now() - lastPulse > 120 ? 0.965 : 1;
      t += 0.006 * speed;
      mouse.x += (mouse.tx - mouse.x) * 0.12; mouse.y += (mouse.ty - mouse.y) * 0.12;

      ctx.clearRect(0, 0, W, H);
      ctx.globalCompositeOperation = theme === 'dark' ? 'lighter' : 'source-over';
      const step = Math.max(10, W / 110);
      for (let i = 0; i < RIBBONS; i++) {
        const g = ctx.createLinearGradient(0, 0, W, 0);
        const k = i / RIBBONS;
        pal.forEach((col, j) => {
          const [r, gg, b] = col;
          const mix = (v: number, to: number) => Math.round(v + (to - v) * green);
          const rr = mix(r, 16), g2 = mix(gg, 185), bb = mix(b, 129);
          const rr2 = Math.round(rr + (255 - rr) * flash * 0.0), alpha = (theme === 'dark' ? 0.34 : 0.3) * (0.35 + 0.65 * Math.sin(k * Math.PI)) + flash * 0.3;
          g.addColorStop(j / (pal.length - 1), `rgba(${flash > 0.05 ? Math.round(rr2 + (239 - rr2) * flash) : rr2},${Math.round(g2 * (1 - flash * 0.7))},${Math.round(bb * (1 - flash * 0.7))},${alpha})`);
        });
        ctx.strokeStyle = g;
        ctx.lineWidth = i % 6 === 0 ? 2 : 1.1;
        ctx.beginPath();
        for (let x = -step; x <= W + step; x += step) {
          const y = yAt(i, x);
          if (x <= -step) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
      // light sparks travelling along ribbons
      for (const s of sparks) {
        s.u += s.v * speed * (1 + energy * 2);
        if (s.u > 1.02) { s.u = -0.02; s.r = Math.floor(Math.random() * RIBBONS); }
        const x = s.u * W, y = yAt(s.r, x);
        const rad = 1.3 + energy * 1.2;
        const grd = ctx.createRadialGradient(x, y, 0, x, y, rad * 4);
        const col = green > 0.5 ? '16,185,129' : theme === 'dark' ? '220,215,255' : '99,102,241';
        grd.addColorStop(0, `rgba(${col},${theme === 'dark' ? 1 : 0.85})`);
        grd.addColorStop(0.25, `rgba(${col},${theme === 'dark' ? 0.55 : 0.35})`);
        grd.addColorStop(1, `rgba(${col},0)`);
        ctx.fillStyle = grd;
        ctx.beginPath(); ctx.arc(x, y, rad * 4, 0, Math.PI * 2); ctx.fill();
      }
      raf = requestAnimationFrame(frame);
    };
    if (reducedMotion()) { t = 1.3; frame(); cancelAnimationFrame(raf); }
    else frame();
    return () => { cancelAnimationFrame(raf); ro.disconnect(); window.removeEventListener('mousemove', onMove); document.removeEventListener('mouseleave', onLeave); };
  }, [theme, ctl]);
  return <canvas ref={ref} className="signal" aria-hidden="true" />;
}

/* ------------------------------------------------------------------ shell */

function Shell({ children, ctl }: { children: ReactNode; ctl: MutableRefObject<SignalCtl> }) {
  const { theme, toggleTheme } = useUi();
  const health = useQuery({ queryKey: ['health'], queryFn: () => api.get<{ status: string }>('/health'), retry: false, refetchInterval: 30000 });
  const up = health.data?.status === 'UP';
  return (
    <div className="auth">
      <Signal ctl={ctl} theme={theme} />
      <div className="vignette" />
      <div className="grain" />
      {children}
      <div className="foot">
        <span className={`status ${health.isError ? 'down' : ''}`} title="Perfmon API status"><i />{health.isLoading ? 'Checking API…' : up ? 'All systems operational' : 'API unreachable'}</span>
        <Link to="/help">Help</Link>
        <a href={`${API_BASE}/api/docs`} target="_blank" rel="noreferrer">API docs</a>
        <button type="button" onClick={toggleTheme} aria-label="Toggle light/dark theme">{theme === 'dark' ? <Sun size={13} /> : <Moon size={13} />}{theme === 'dark' ? 'Light' : 'Dark'}</button>
      </div>
    </div>
  );
}

const Mark = () => <div className="mark"><LogoMark size={52} animated /></div>;

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
      setTimeout(() => nav(loc.state?.from ?? '/', { replace: true }), reducedMotion() ? 0 : 1100);
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
        <h1 className="title">Welcome <em>back</em></h1>
        <p className="lede">Sign in to Perfmon — performance engineering, observability and intelligence.</p>
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
        <h1 className="title">Reset <em>password</em></h1>
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
        <h1 className="title">New <em>password</em></h1>
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
