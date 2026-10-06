import { useEffect, useMemo, useRef, useState, type FormEvent, type MouseEvent, type ReactNode } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { AlertCircle, ChevronDown, Eye, EyeOff, Moon, Sparkles, Sun, CheckCircle2 } from 'lucide-react';
import { useAuth } from '@/stores/auth';
import { useUi } from '@/stores/ui';
import { api, ApiError, API_BASE } from '@/services/api';
import { LogoMark } from '@/components/Logo';
import '@/styles/login.css';

const reducedMotion = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/** Turn transport/API failures into actionable messages instead of a bare status code. */
function explain(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 401) return 'Wrong email or password. Try again or click Forgot password to reset it.';
    if (err.status === 423) return err.message;
    if (err.status === 429) return 'Too many attempts. Please wait a minute and try again.';
    if (err.status === 404 || err.status === 405 || err.code === 'HTTP_ERROR' || err.status >= 502)
      return `Perfmon API is not reachable at ${API_BASE || window.location.origin}/api/v1. If this UI is hosted separately (e.g. Vercel), set VITE_API_BASE_URL to your backend URL.`;
    return err.message;
  }
  return `Couldn't reach the Perfmon API${API_BASE ? ` at ${API_BASE}` : ''}. Check that the backend is running.`;
}

/* ------------------------------------------------------------------ animated background */

const FLOAT_COLORS = ['#4285f4', '#ea4335', '#fbbc04', '#34a853', '#9b72cb', '#14b8a6'];

function Background() {
  const ref = useRef<HTMLDivElement>(null);
  const floaters = useMemo(() => Array.from({ length: 16 }, (_, i) => {
    const size = 10 + ((i * 37) % 26);
    return {
      left: `${(i * 61) % 100}%`, size, color: FLOAT_COLORS[i % FLOAT_COLORS.length],
      radius: i % 3 === 0 ? '50%' : i % 3 === 1 ? '6px' : '2px', ring: i % 4 === 0,
      duration: 18 + ((i * 7) % 16), delay: -((i * 3.7) % 20),
    };
  }), []);
  useEffect(() => {
    if (reducedMotion()) return;
    const el = ref.current!;
    const move = (e: globalThis.MouseEvent) => { el.style.setProperty('--mx', `${e.clientX}px`); el.style.setProperty('--my', `${e.clientY}px`); };
    window.addEventListener('mousemove', move);
    return () => window.removeEventListener('mousemove', move);
  }, []);
  const wave = (amp: number, len: number, y: number) => {
    let d = `M0 ${y}`;
    for (let x = 0; x <= 2400; x += len) d += ` Q ${x + len / 4} ${y - amp} ${x + len / 2} ${y} T ${x + len} ${y}`;
    return d;
  };
  return (
    <div className="bg" ref={ref} aria-hidden="true">
      <div className="blob b1" /><div className="blob b2" /><div className="blob b3" /><div className="blob b4" /><div className="blob b5" />
      <div className="dots" />
      <div className="cursor-glow" />
      <div className="floaters">
        {floaters.map((f, i) => (
          <span key={i} style={{
            left: f.left, width: f.size, height: f.size, borderRadius: f.radius, animationDuration: `${f.duration}s`, animationDelay: `${f.delay}s`,
            background: f.ring ? 'transparent' : `${f.color}55`, border: f.ring ? `2px solid ${f.color}88` : undefined,
          }} />
        ))}
      </div>
      <div className="waves">
        <svg className="w3" viewBox="0 0 2400 200" preserveAspectRatio="none"><path d={wave(26, 300, 120)} fill="none" stroke="#34a853" strokeOpacity=".35" strokeWidth="2" /></svg>
        <svg className="w2" viewBox="0 0 2400 200" preserveAspectRatio="none"><path d={wave(38, 400, 140)} fill="none" stroke="#ea4335" strokeOpacity=".3" strokeWidth="2" /></svg>
        <svg className="w1" viewBox="0 0 2400 200" preserveAspectRatio="none">
          <defs><linearGradient id="wg" x1="0" x2="1"><stop offset="0" stopColor="#4285f4" /><stop offset=".33" stopColor="#9b72cb" /><stop offset=".66" stopColor="#d96570" /><stop offset="1" stopColor="#4285f4" /></linearGradient></defs>
          <path d={wave(30, 240, 160)} fill="none" stroke="url(#wg)" strokeOpacity=".55" strokeWidth="2.5" />
        </svg>
      </div>
    </div>
  );
}

function ripple(e: MouseEvent<HTMLButtonElement>) {
  const b = e.currentTarget;
  const r = b.getBoundingClientRect();
  const s = Math.max(r.width, r.height);
  const span = document.createElement('span');
  span.className = 'ripple';
  span.style.cssText = `width:${s}px;height:${s}px;left:${e.clientX - r.left - s / 2}px;top:${e.clientY - r.top - s / 2}px`;
  b.appendChild(span);
  setTimeout(() => span.remove(), 650);
}

function Shell({ children, busy }: { children: ReactNode; busy?: boolean }) {
  const { theme, toggleTheme } = useUi();
  return (
    <div className="auth">
      <Background />
      <div className="stage">
        <div className={`gcard ${busy ? 'busy' : ''}`}>
          {busy && <div className="progress" />}
          <div className="glogo"><LogoMark size={36} animated /><span className="word">Perf<span>mon</span></span></div>
          {children}
        </div>
        <div className="gfoot">
          <button type="button" onClick={toggleTheme} aria-label="Toggle light/dark theme">{theme === 'dark' ? <Sun size={14} /> : <Moon size={14} />}{theme === 'dark' ? 'Light' : 'Dark'} mode <ChevronDown size={12} style={{ opacity: 0 }} /></button>
          <nav><Link to="/help">Help</Link><a href="/api/docs" target="_blank" rel="noreferrer">API</a><span style={{ padding: '6px 4px' }}>© {new Date().getFullYear()} Perfmon</span></nav>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ pages */

export function LoginPage() {
  const login = useAuth((s) => s.login);
  const nav = useNavigate();
  const loc = useLocation() as { state?: { from?: string } };
  const saved = (() => { try { return localStorage.getItem('perfmon.lastEmail') ?? ''; } catch { return ''; } })();
  const [step, setStep] = useState<'email' | 'password'>('email');
  const [dir, setDir] = useState<'fwd' | 'back'>('fwd');
  const [email, setEmail] = useState(saved);
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [caps, setCaps] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [state, setState] = useState<'idle' | 'busy' | 'done'>('idle');
  const [errKey, setErrKey] = useState(0);
  const cfg = useQuery({ queryKey: ['auth-config'], queryFn: () => api.get<{ demo?: { email: string; password?: string } | null }>('/auth/config'), retry: false, staleTime: Infinity });
  const demo = cfg.data?.demo;

  const goPassword = (e?: FormEvent) => {
    e?.preventDefault();
    const v = email.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) { setError('Enter a valid email address'); setErrKey((k) => k + 1); return; }
    setError(null); setDir('fwd'); setStep('password');
    setTimeout(() => document.getElementById('password')?.focus(), 60);
  };
  const back = () => { setDir('back'); setStep('email'); setError(null); setPassword(''); };

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!password) { setError('Enter a password'); setErrKey((k) => k + 1); return; }
    setState('busy'); setError(null);
    try {
      await login(email.trim(), password);
      try { localStorage.setItem('perfmon.lastEmail', email.trim()); } catch { /* ignore */ }
      setState('done');
      setTimeout(() => nav(loc.state?.from ?? '/', { replace: true }), reducedMotion() ? 0 : 600);
    } catch (err) {
      setError(explain(err)); setErrKey((k) => k + 1); setState('idle');
    }
  };

  const useDemo = async () => {
    if (!demo) return;
    setError(null);
    if (!reducedMotion()) for (let i = 1; i <= demo.email.length; i++) { setEmail(demo.email.slice(0, i)); await new Promise((r) => setTimeout(r, 18)); }
    else setEmail(demo.email);
    setDir('fwd'); setStep('password');
    if (demo.password) {
      await new Promise((r) => setTimeout(r, 250));
      for (let i = 1; i <= demo.password.length; i++) { setPassword(demo.password.slice(0, i)); await new Promise((r) => setTimeout(r, 30)); }
    }
    setTimeout(() => document.getElementById('password')?.focus(), 60);
  };

  const initials = email.trim().slice(0, 1).toUpperCase() || 'P';

  return (
    <Shell busy={state === 'busy'}>
      {step === 'email' ? (
        <form key="email" className={`gform step ${dir === 'back' ? 'back' : ''}`} onSubmit={goPassword} noValidate>
          <h1>Sign in</h1>
          <p className="sub">to continue to Perfmon</p>
          <div className={`tf ${error ? 'err' : ''}`}>
            <input id="email" type="email" placeholder=" " autoComplete="username" value={email} onChange={(e) => { setEmail(e.target.value); setError(null); }} autoFocus />
            <label htmlFor="email">Email</label>
          </div>
          {error && <div key={errKey} className="err-msg" role="alert"><AlertCircle size={16} />{error}</div>}
          <Link to="/forgot-password" className="glink">Forgot email or password?</Link>
          {demo && (
            <p className="hint">
              <button type="button" className="glink demo-link" onClick={useDemo}><Sparkles size={14} /> Use demo account</button>
              <span style={{ display: 'block' }}>{demo.email}{demo.password ? ` · ${demo.password}` : ''}</span>
            </p>
          )}
          <div className="actions">
            <span />
            <button className="gbtn" type="submit" onMouseDown={ripple}>Next</button>
          </div>
        </form>
      ) : (
        <form key="password" className="gform step" onSubmit={submit} noValidate>
          <h1>Welcome</h1>
          <button type="button" className="chip-user" onClick={back} title="Use a different account">
            <span className="av">{initials}</span><span className="e">{email}</span><ChevronDown size={14} />
          </button>
          <div className={`tf ${error ? 'err' : ''}`}>
            <input id="password" type={show ? 'text' : 'password'} placeholder=" " autoComplete="current-password" value={password}
              onChange={(e) => { setPassword(e.target.value); setError(null); }}
              onKeyUp={(e) => setCaps(e.getModifierState?.('CapsLock') ?? false)} onKeyDown={(e) => setCaps(e.getModifierState?.('CapsLock') ?? false)} />
            <label htmlFor="password">Enter your password</label>
            <button type="button" className="tf-btn" onClick={() => setShow((v) => !v)} aria-label={show ? 'Hide password' : 'Show password'}>{show ? <EyeOff size={20} /> : <Eye size={20} />}</button>
          </div>
          {error && <div key={errKey} className="err-msg" role="alert"><AlertCircle size={16} />{error}</div>}
          {caps && <div className="caps"><AlertCircle size={14} /> Caps Lock is on</div>}
          <label className="check"><input type="checkbox" checked={show} onChange={(e) => setShow(e.target.checked)} /> Show password</label>
          <div className="actions">
            <Link to="/forgot-password" className="glink">Forgot password?</Link>
            <button className={`gbtn ${state === 'done' ? 'success' : ''}`} type="submit" disabled={state !== 'idle'} onMouseDown={ripple}>
              {state === 'busy' && <span className="spinner" />}
              {state === 'done' && <svg className="tick" width="16" height="16" viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" /></svg>}
              {state === 'done' ? 'Signed in' : 'Sign in'}
            </button>
          </div>
        </form>
      )}
    </Shell>
  );
}

export function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <Shell busy={busy}>
      <form className="gform step" onSubmit={async (e) => { e.preventDefault(); setBusy(true); await api.post('/auth/forgot-password', { email }).catch(() => undefined); setBusy(false); setSent(true); }}>
        <h1>Account recovery</h1>
        <p className="sub">Enter your email and we'll send you a reset link</p>
        {sent ? <div className="notice-ok"><CheckCircle2 size={18} />If an account exists for that email, a reset link is on its way. It expires in 30 minutes.</div> : (
          <div className="tf"><input id="fp-email" type="email" placeholder=" " value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus /><label htmlFor="fp-email">Email</label></div>
        )}
        <div className="actions">
          <Link to="/login" className="glink">Back to sign in</Link>
          {!sent && <button className="gbtn" type="submit" disabled={busy} onMouseDown={ripple}>Send link</button>}
        </div>
      </form>
    </Shell>
  );
}

export function ResetPasswordPage() {
  const token = new URLSearchParams(window.location.search).get('token') ?? '';
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const valid = password.length >= 8 && /[A-Za-z]/.test(password) && /\d/.test(password);
  return (
    <Shell>
      <form className="gform step" onSubmit={async (e) => {
        e.preventDefault();
        try { await api.post('/auth/reset-password', { token, password }); setMsg({ ok: true, text: 'Password updated. You can sign in now.' }); }
        catch (err) { setMsg({ ok: false, text: explain(err) }); }
      }}>
        <h1>Create password</h1>
        <p className="sub">Use 8 or more characters with letters and numbers</p>
        {msg?.ok && <div className="notice-ok"><CheckCircle2 size={18} />{msg.text}</div>}
        <div className={`tf ${msg && !msg.ok ? 'err' : ''}`}>
          <input id="np" type={show ? 'text' : 'password'} placeholder=" " value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} autoFocus />
          <label htmlFor="np">New password</label>
          <button type="button" className="tf-btn" onClick={() => setShow((v) => !v)} aria-label={show ? 'Hide password' : 'Show password'}>{show ? <EyeOff size={20} /> : <Eye size={20} />}</button>
        </div>
        {msg && !msg.ok && <div className="err-msg" role="alert"><AlertCircle size={16} />{msg.text}</div>}
        <div className="actions">
          <Link to="/login" className="glink">Back to sign in</Link>
          <button className="gbtn" type="submit" disabled={!valid} onMouseDown={ripple}>Save</button>
        </div>
      </form>
    </Shell>
  );
}
