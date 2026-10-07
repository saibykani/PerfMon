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
    if (err.status === 404 || err.status === 405 || err.code === 'HTTP_ERROR' || err.code === 'TIMEOUT' || err.status >= 502)
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

/** True when the browser renders without GPU acceleration or the device is low-end. */
function detectLowPower() {
  try {
    if ((navigator.hardwareConcurrency ?? 8) <= 2) return true;
    const gl = document.createElement('canvas').getContext('webgl');
    if (!gl) return true;
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const renderer = ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : '';
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return /swiftshader|llvmpipe|software|basic render/i.test(renderer);
  } catch {
    return false;
  }
}

function Signal({ ctl, theme }: { ctl: MutableRefObject<SignalCtl>; theme: 'light' | 'dark' }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current!;
    const ctx = c.getContext('2d', { alpha: true })!;
    // Performance budget: capped resolution + frame rate, cached gradients, sprite particles.
    const dpr = 1; // waves are soft; 1x keeps raster cost low on machines without GPU acceleration
    const RIBBONS = 16;
    let W = 0, H = 0, raf = 0, last = 0;
    let gradKey = '';
    const mouse = { x: -9999, y: -9999, tx: -9999, ty: -9999 };
    const pal = PALETTE[theme];

    // Pre-rendered glow sprites for particles (drawImage is far cheaper than per-frame radial gradients)
    const makeSprite = (rgb: string) => {
      const sc = document.createElement('canvas');
      sc.width = sc.height = 24;
      const g = sc.getContext('2d')!;
      const rg = g.createRadialGradient(12, 12, 0, 12, 12, 12);
      rg.addColorStop(0, `rgba(${rgb},1)`); rg.addColorStop(0.25, `rgba(${rgb},0.5)`); rg.addColorStop(1, `rgba(${rgb},0)`);
      g.fillStyle = rg; g.fillRect(0, 0, 24, 24);
      return sc;
    };
    const sprite = makeSprite(theme === 'dark' ? '220,215,255' : '99,102,241');
    const spriteOk = makeSprite('16,185,129');

    // Solid color per ribbon (cycling the palette) — far cheaper to rasterize than gradient strokes.
    let colors: string[] = [];
    const buildGrads = (green: number, flash: number) => {
      const key = `${green.toFixed(1)}|${flash.toFixed(1)}`;
      if (key === gradKey) return;
      gradKey = key;
      colors = [];
      for (let i = 0; i < RIBBONS; i++) {
        const k = i / RIBBONS;
        const [r, gg, b] = pal[i % pal.length];
        const alpha = (theme === 'dark' ? 0.42 : 0.34) * (0.35 + 0.65 * Math.sin(k * Math.PI)) + flash * 0.3;
        const R = Math.round(r + (16 - r) * green + (239 - r) * flash * 0.8);
        const G = Math.round((gg + (185 - gg) * green) * (1 - flash * 0.7));
        const B = Math.round((b + (129 - b) * green) * (1 - flash * 0.7));
        colors.push(`rgba(${R},${G},${B},${Math.min(1, alpha).toFixed(3)})`);
      }
    };
    const resize = () => {
      W = c.clientWidth; H = c.clientHeight; top = c.getBoundingClientRect().top;
      c.width = Math.round(W * dpr); c.height = Math.round(H * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      gradKey = '';
    };
    let top = 0;
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(c);
    const onMove = (e: MouseEvent) => { mouse.tx = e.clientX; mouse.ty = e.clientY - top; };
    const onLeave = () => { mouse.tx = -9999; mouse.ty = -9999; };
    window.addEventListener('mousemove', onMove, { passive: true });
    document.addEventListener('mouseleave', onLeave);

    const sparks = Array.from({ length: 16 }, (_, i) => ({ r: i % RIBBONS, u: Math.random(), v: 0.0008 + Math.random() * 0.0016 }));
    let t = 0, energy = 0, amp = 1, flash = 0, speed = 1, green = 0, lastPulse = 0;
    ctl.current.pulse = () => { energy = Math.min(1, energy + 0.22); lastPulse = performance.now(); };

    const yAt = (i: number, x: number) => {
      const nx = x / W;
      const base = H * 0.52 + (i - RIBBONS / 2) * (H * 0.026);
      const a = H * 0.22 * amp * (1 + energy * 0.9);
      const w = Math.sin(nx * 5.2 + t * 0.9 + i * 0.22) * 0.55 + Math.sin(nx * 9.5 - t * 1.3 + i * 0.13) * 0.28 + Math.sin(nx * 2.1 + t * 0.4 - i * 0.07) * 0.5;
      let y = base + a * w * (0.65 + 0.35 * Math.sin(i * 0.55 + t * 0.2));
      const dx = x - mouse.x, dy = y - mouse.y;
      if (dx * dx + dy * dy < 90000) y += 64 * Math.tanh(dy / 38) * Math.exp(-(dx * dx) / 22000) * Math.exp(-(dy * dy) / 30000) * amp;
      return y;
    };

    const draw = () => {
      const mode = ctl.current.mode;
      speed += ((mode === 'busy' ? 3.2 : 1) - speed) * 0.08;
      amp += ((mode === 'success' ? 0.02 : 1) - amp) * (mode === 'success' ? 0.09 : 0.06);
      green += ((mode === 'success' ? 1 : 0) - green) * 0.08;
      if (mode === 'error' && flash < 0.05) flash = 1;
      flash *= 0.9;
      if (flash < 0.02) flash = 0;
      if (performance.now() - lastPulse > 120) energy *= 0.95;
      t += 0.009 * speed;
      mouse.x += (mouse.tx - mouse.x) * 0.18; mouse.y += (mouse.ty - mouse.y) * 0.18;

      buildGrads(green, flash);
      ctx.clearRect(0, 0, W, H);
      const step = Math.max(18, W / 64);
      for (let i = 0; i < RIBBONS; i++) {
        ctx.strokeStyle = colors[i];
        ctx.lineWidth = i % 5 === 0 ? 2 : 1.1;
        ctx.beginPath();
        ctx.moveTo(-step, yAt(i, -step));
        for (let x = 0; x <= W + step; x += step) ctx.lineTo(x, yAt(i, x));
        ctx.stroke();
      }
      const spr = green > 0.5 ? spriteOk : sprite;
      for (const s of sparks) {
        s.u += s.v * speed * (1 + energy * 2);
        if (s.u > 1.02) { s.u = -0.02; s.r = (Math.random() * RIBBONS) | 0; }
        const x = s.u * W, y = yAt(s.r, x);
        const size = 9 + energy * 6;
        ctx.drawImage(spr, x - size / 2, y - size / 2, size, size);
      }
    };

    // Adaptive quality: software rendering (no GPU) or a struggling browser gets a low-power mode.
    let lowPower = detectLowPower();
    let slowFrames = 0;
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      const idle = ctl.current.mode === 'idle' && energy < 0.02 && Math.abs(mouse.tx - mouse.x) < 1 && flash === 0;
      const budget = lowPower ? (idle ? 125 : 60) : idle ? 80 : 33;
      const gap = now - last;
      if (gap < budget) return;
      if (last && !lowPower) {
        slowFrames = gap > budget * 2.5 ? slowFrames + 1 : Math.max(0, slowFrames - 1);
        if (slowFrames > 12) lowPower = true;
      }
      last = now;
      const t0 = performance.now();
      draw();
      if (!lowPower && performance.now() - t0 > 12) slowFrames += 2;
    };
    if (reducedMotion()) { t = 1.3; draw(); }
    else raf = requestAnimationFrame(loop);
    return () => { cancelAnimationFrame(raf); ro.disconnect(); window.removeEventListener('mousemove', onMove); document.removeEventListener('mouseleave', onLeave); };
  }, [theme, ctl]);
  return <canvas ref={ref} className="signal" aria-hidden="true" />;
}

/* ------------------------------------------------------------------ shell */

function Shell({ children, ctl }: { children: ReactNode; ctl: MutableRefObject<SignalCtl> }) {
  const { theme, toggleTheme } = useUi();
  const health = useQuery({ queryKey: ['health'], queryFn: () => api.get<{ status: string }>('/health'), retry: false, refetchInterval: 30000, refetchOnWindowFocus: false });
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
