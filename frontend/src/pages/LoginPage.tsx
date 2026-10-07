import { useEffect, useRef, useState, type FormEvent, type ReactNode, type MutableRefObject } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { AlertCircle, ArrowRight, CheckCircle2, Eye, EyeOff, Heart } from 'lucide-react';
import { useAuth } from '@/stores/auth';
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

/* ------------------------------------------------------------------ Pulse: heart-monitor trace */

type Mode = 'idle' | 'busy' | 'success' | 'error';
interface SignalCtl { pulse: () => void; mode: Mode }

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

/** One PQRST heartbeat, u in [0,1) → offset in units of amplitude (negative = up). */
function beat(u: number) {
  const g = (c: number, w: number, a: number) => a * Math.exp(-((u - c) ** 2) / (2 * w * w));
  return g(0.18, 0.025, -0.12) + g(0.3, 0.008, 0.18) + g(0.33, 0.011, -1) + g(0.365, 0.01, 0.38) + g(0.58, 0.045, -0.22);
}

/**
 * A sweeping ECG trace (like a bedside monitor) on a cheap 1x canvas: a ring buffer of
 * samples, a moving write head and an erase gap. Typing adds blips, signing in raises the
 * heart rate, success turns it green, an error spikes red.
 */
function Pulse({ ctl, onBpm }: { ctl: MutableRefObject<SignalCtl>; onBpm: (bpm: number) => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current!;
    const ctx = c.getContext('2d')!;
    const STEP = 3;      // px per sample
    const SWEEP = 300;   // px per second
    let W = 0, H = 0, N = 0, raf = 0, last = 0;
    let ys = new Float32Array(0);
    let head = 0, phase = 0, blip = 0, spike = 0, green = 0, bpm = 64, shownBpm = 0;
    const resize = () => {
      W = c.clientWidth; H = c.clientHeight;
      c.width = W; c.height = H;
      N = Math.max(2, Math.ceil(W / STEP) + 1);
      ys = new Float32Array(N).fill(H / 2);
      head = 0;
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(c);
    ctl.current.pulse = () => { blip = Math.min(1, blip + 0.5); };

    const advance = (samples: number) => {
      const mode = ctl.current.mode;
      const target = mode === 'busy' ? 150 : mode === 'success' ? 58 : 64 + blip * 36;
      bpm += (target - bpm) * 0.06;
      green += ((mode === 'success' ? 1 : 0) - green) * 0.08;
      if (mode === 'error' && spike < 0.05) spike = 1;
      for (let k = 0; k < samples; k++) {
        phase += (bpm / 60) * (STEP / SWEEP);
        if (phase >= 1) phase -= 1;
        const amp = H * 0.36;
        let y = beat(phase) * amp + (Math.random() - 0.5) * (1 + blip * 6) + Math.sin(phase * 60) * blip * 5;
        if (spike > 0.03) { y += spike * H * 0.38 * (k % 2 ? 1 : -1); spike *= 0.9; }
        ys[head] = H * 0.5 + y;
        head = (head + 1) % N;
      }
      blip *= 0.96;
      const shown = Math.round(bpm);
      if (shown !== shownBpm) { shownBpm = shown; onBpm(shown); }
    };

    const color = (a: number) => {
      if (spike > 0.05) return `rgba(255,92,110,${a})`;
      const r = Math.round(125 + (52 - 125) * green), g = Math.round(211 + (230 - 211) * green), b = Math.round(252 + (140 - 252) * green);
      return `rgba(${r},${g},${b},${a})`;
    };

    const draw = () => {
      ctx.clearRect(0, 0, W, H);
      const GAP = 16;          // erased samples ahead of the write head
      const SEG = 6;           // trail drawn in segments with decaying alpha
      const len = N - GAP;
      const per = Math.ceil(len / SEG);
      ctx.lineJoin = 'round'; ctx.lineCap = 'round';
      for (let s = 0; s < SEG; s++) {
        ctx.strokeStyle = color(0.06 + 0.94 * ((s + 1) / SEG) ** 2);
        ctx.lineWidth = s >= SEG - 2 ? 2.2 : 1.5;
        ctx.beginPath();
        let prevX = -1;
        for (let j = s * per; j <= Math.min(len - 1, (s + 1) * per); j++) {
          const idx = (head + GAP + j) % N;       // oldest → newest
          const x = idx * STEP;
          if (prevX < 0 || x < prevX) ctx.moveTo(x, ys[idx]); // wrap at the right edge
          else ctx.lineTo(x, ys[idx]);
          prevX = x;
        }
        ctx.stroke();
      }
      const hi = (head - 1 + N) % N;
      ctx.fillStyle = color(1);
      ctx.shadowColor = color(0.9); ctx.shadowBlur = 16;
      ctx.beginPath(); ctx.arc(hi * STEP, ys[hi], 3.4, 0, Math.PI * 2); ctx.fill();
      ctx.shadowBlur = 0;
    };

    let lowPower = detectLowPower();
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      if (now - last < (lowPower ? 50 : 16)) return;
      const dt = last ? Math.min(120, now - last) : 16;
      last = now;
      advance(Math.max(1, Math.round(((dt / 1000) * SWEEP) / STEP)));
      const t0 = performance.now();
      draw();
      if (!lowPower && performance.now() - t0 > 10) lowPower = true;
    };
    if (reducedMotion()) { advance(N); draw(); }
    else raf = requestAnimationFrame(loop);
    return () => { cancelAnimationFrame(raf); ro.disconnect(); };
  }, [ctl, onBpm]);
  return <canvas ref={ref} className="pulse" aria-hidden="true" />;
}

/* ------------------------------------------------------------------ shell */

function Shell({ children, ctl }: { children: ReactNode; ctl: MutableRefObject<SignalCtl> }) {
  const [bpm, setBpm] = useState(64);
  const health = useQuery({
    queryKey: ['health-timed'], retry: false, refetchInterval: 20000, refetchOnWindowFocus: false,
    queryFn: async () => { const t0 = performance.now(); const r = await api.get<{ status: string }>('/health'); return { ...r, ms: Math.round(performance.now() - t0) }; },
  });
  const up = health.data?.status === 'UP';
  return (
    <div className="auth">
      <div className="grid-bg" />
      <div className="aurora" />
      <Pulse ctl={ctl} onBpm={setBpm} />
      <div className="brand-giant" aria-hidden="true">PERFMON</div>
      <header className="top">
        <div className="auth-brand"><LogoMark size={30} /><span>Perf<b>mon</b></span></div>
        <div className="chips">
          <span className="chip" title="The trace reacts as you type and sign in"><Heart size={12} className="beat" /><b className="num">{bpm}</b> bpm</span>
          <span className={`chip ${health.isError ? 'down' : up ? 'up' : ''}`} title="Measured round-trip to the Perfmon API">
            <i />{health.isLoading ? 'Checking API…' : up ? <>API <b className="num">{health.data!.ms} ms</b></> : 'API unreachable'}
          </span>
        </div>
      </header>
      {children}
      <footer className="foot">
        <span>© {new Date().getFullYear()} Perfmon</span>
        <Link to="/help">Help</Link>
        <a href={`${API_BASE}/api/docs`} target="_blank" rel="noreferrer">API docs</a>
      </footer>
    </div>
  );
}

const Mark = () => (
  <div className="hero">
    <div className="mark"><LogoMark size={60} animated /></div>
    <div className="wordmark">Perf<span>mon</span></div>
    <div className="tagline">Performance Engineering <i /> Observability <i /> Intelligence</div>
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
