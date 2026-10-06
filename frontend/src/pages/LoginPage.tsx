import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { AlertCircle, ArrowRight, CheckCircle2, Eye, EyeOff, KeyRound, Lock, Mail, Moon, ShieldCheck, Sparkles, Sun, Zap, Gauge, TrendingDown, ArrowUpRight } from 'lucide-react';
import { useAuth } from '@/stores/auth';
import { useUi } from '@/stores/ui';
import { api, ApiError, API_BASE } from '@/services/api';
import { Logo } from '@/components/Logo';
import '@/styles/login.css';

const reducedMotion = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

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

/* ------------------------------------------------------------------ hero pieces */

function Particles() {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c || reducedMotion()) return;
    const ctx = c.getContext('2d')!;
    let w = 0, h = 0, raf = 0;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const pts = Array.from({ length: 70 }, () => ({ x: Math.random(), y: Math.random(), vx: (Math.random() - 0.5) * 0.00025, vy: (Math.random() - 0.5) * 0.00025, r: Math.random() * 1.4 + 0.4 }));
    const resize = () => { w = c.clientWidth; h = c.clientHeight; c.width = w * dpr; c.height = h * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0); };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(c);
    const tick = () => {
      ctx.clearRect(0, 0, w, h);
      for (const p of pts) {
        p.x = (p.x + p.vx + 1) % 1; p.y = (p.y + p.vy + 1) % 1;
        ctx.beginPath(); ctx.arc(p.x * w, p.y * h, p.r, 0, Math.PI * 2); ctx.fillStyle = 'rgba(226,232,255,0.55)'; ctx.fill();
      }
      for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) {
        const dx = (pts[i].x - pts[j].x) * w, dy = (pts[i].y - pts[j].y) * h, d = Math.hypot(dx, dy);
        if (d < 110) { ctx.strokeStyle = `rgba(167,139,250,${0.16 * (1 - d / 110)})`; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(pts[i].x * w, pts[i].y * h); ctx.lineTo(pts[j].x * w, pts[j].y * h); ctx.stroke(); }
      }
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => { cancelAnimationFrame(raf); ro.disconnect(); };
  }, []);
  return <canvas ref={ref} className="hero-particles" style={{ width: '100%', height: '100%' }} />;
}

const WORDS = ['in ten seconds.', 'before users notice.', 'with evidence, not guesses.', 'across every build.'];
function Rotator() {
  const [i, setI] = useState(0);
  useEffect(() => { if (reducedMotion()) return; const t = setInterval(() => setI((x) => (x + 1) % WORDS.length), 2600); return () => clearInterval(t); }, []);
  return <span className="rotator">{WORDS.map((w, k) => <span key={w} className={k === i ? 'on' : ''} aria-hidden={k !== i}>{w}</span>)}</span>;
}

/** Live-ticking dashboard mock: the line scrolls and KPIs update every second. */
function LiveMock() {
  const N = 60, W = 600, H = 130;
  const [tps, setTps] = useState<number[]>(() => Array.from({ length: N }, (_, i) => 150 + 40 * Math.sin(i / 6) + Math.random() * 12));
  const [p95, setP95] = useState<number[]>(() => Array.from({ length: N }, (_, i) => 70 + 12 * Math.cos(i / 5) + Math.random() * 8));
  useEffect(() => {
    if (reducedMotion()) return;
    let k = N;
    const t = setInterval(() => {
      k++;
      setTps((a) => [...a.slice(1), 160 + 38 * Math.sin(k / 6) + Math.random() * 14]);
      setP95((a) => [...a.slice(1), 72 + 14 * Math.cos(k / 5) + Math.random() * 9 + (k % 23 < 3 ? 18 : 0)]);
    }, 1000);
    return () => clearInterval(t);
  }, []);
  const path = (arr: number[], max: number) => arr.map((v, i) => `${i ? 'L' : 'M'}${((i / (N - 1)) * W).toFixed(1)},${(H - 6 - (v / max) * (H - 12)).toFixed(1)}`).join(' ');
  const tpsPath = path(tps, 230);
  const lastT = tps[N - 1], lastP = p95[N - 1] * 14;
  return (
    <div className="mock-card">
      <div className="mock-head"><span><b>PF-2026-10-06-000127</b> · 200 TPS Payment Load · Build 104</span><span className="mock-live"><i />LIVE</span></div>
      <div className="mock-kpis">
        <div className="mock-kpi"><small>TPS</small><strong>{lastT.toFixed(1)}</strong><em style={{ color: '#6ee7b7' }}>▲</em></div>
        <div className="mock-kpi"><small>P95</small><strong>{(lastP / 1000).toFixed(2)}s</strong></div>
        <div className="mock-kpi"><small>Errors</small><strong>0.42%</strong></div>
        <div className="mock-kpi"><small>Users</small><strong>200</strong></div>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
        <defs>
          <linearGradient id="mk-a" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor="#a78bfa" stopOpacity=".45" /><stop offset="1" stopColor="#a78bfa" stopOpacity="0" /></linearGradient>
          <linearGradient id="mk-l" x1="0" x2="1"><stop offset="0" stopColor="#c084fc" /><stop offset=".5" stopColor="#60a5fa" /><stop offset="1" stopColor="#2dd4bf" /></linearGradient>
        </defs>
        {[0.25, 0.5, 0.75].map((y) => <line key={y} x1="0" x2={W} y1={H * y} y2={H * y} stroke="rgba(255,255,255,0.07)" />)}
        <path d={`${tpsPath} L${W},${H} L0,${H} Z`} fill="url(#mk-a)" />
        <path d={tpsPath} fill="none" stroke="url(#mk-l)" strokeWidth="2.4" strokeLinejoin="round" strokeLinecap="round" />
        <path d={path(p95, 230)} fill="none" stroke="#f9a8d4" strokeWidth="1.8" strokeDasharray="5 4" strokeLinejoin="round" />
        <circle cx={W} cy={H - 6 - (lastT / 230) * (H - 12)} r="4.5" fill="#fff"><animate attributeName="r" values="4;7;4" dur="1.4s" repeatCount="indefinite" /></circle>
      </svg>
      <div className="mock-legend"><span><i style={{ background: 'linear-gradient(90deg,#c084fc,#2dd4bf)' }} />Throughput (TPS)</span><span><i style={{ background: '#f9a8d4' }} />P95 latency</span></div>
    </div>
  );
}

const INTEGRATIONS = ['Apache JMeter', 'InfluxDB', 'Prometheus', 'Dynatrace', 'Grafana', 'OpenTelemetry', 'Jenkins', 'GitHub Actions', 'GitLab CI', 'Azure DevOps', 'MinIO / S3'];

function Hero() {
  const ref = useRef<HTMLDivElement>(null);
  const mockRef = useRef<HTMLDivElement>(null);
  const onMove = (e: React.MouseEvent) => {
    if (reducedMotion()) return;
    const r = ref.current!.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;
    ref.current!.style.setProperty('--mx', `${x * 100}%`);
    ref.current!.style.setProperty('--my', `${y * 100}%`);
    if (mockRef.current) mockRef.current.style.transform = `perspective(1200px) rotateY(${(x - 0.5) * 8}deg) rotateX(${(0.5 - y) * 6}deg)`;
  };
  return (
    <section className="auth-hero" ref={ref} onMouseMove={onMove} onMouseLeave={() => mockRef.current && (mockRef.current.style.transform = '')} aria-hidden="true">
      <div className="aurora"><i /><i /><i /><i /></div>
      <div className="hero-grid" />
      <Particles />
      <div className="hero-spot" />
      <div className="hero-top">
        <Logo size={38} animated />
        <span className="hero-status"><i />All systems operational</span>
      </div>
      <div className="hero-copy">
        <span className="hero-pill"><b>NEW</b> Bottleneck analyzer with confidence scoring <ArrowUpRight size={14} /></span>
        <h2 className="hero-title display">Understand every test run<br /><Rotator /></h2>
        <p className="hero-sub">Stream JMeter results, correlate infrastructure, catch regressions against your baseline and give stakeholders reports they trust — every number traced to a single Run ID.</p>
        <div className="mock" ref={mockRef}>
          <LiveMock />
          <div className="chip c1"><span className="ico" style={{ background: 'linear-gradient(135deg,#8b5cf6,#3b82f6)' }}><Zap size={16} /></span><div><small>Throughput</small><strong>+13.9% vs baseline</strong></div></div>
          <div className="chip c2"><span className="ico" style={{ background: 'linear-gradient(135deg,#ec4899,#f59e0b)' }}><TrendingDown size={16} /></span><div><small>Likely bottleneck</small><strong>Database · 87%</strong></div></div>
          <div className="chip c3"><span className="ico" style={{ background: 'linear-gradient(135deg,#14b8a6,#22c55e)' }}><Gauge size={16} /></span><div><small>SLA compliance</small><strong>96.8% · PASS</strong></div></div>
        </div>
      </div>
      <div className="marquee">
        <div className="marquee-label">Works with your stack</div>
        <div className="marquee-track">{[...INTEGRATIONS, ...INTEGRATIONS].map((n, i) => <span key={i}>{n}</span>)}</div>
      </div>
    </section>
  );
}

function AuthShell({ children }: { children: ReactNode }) {
  const { theme, toggleTheme } = useUi();
  return (
    <div className="auth">
      <Hero />
      <section className="auth-panel">
        <span className="panel-blob b1" /><span className="panel-blob b2" /><span className="panel-blob b3" />
        <button className="theme-btn" type="button" onClick={toggleTheme} aria-label="Toggle light/dark theme">{theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}</button>
        {children}
      </section>
    </div>
  );
}

function Alert({ title, detail, ok }: { title: string; detail?: string; ok?: boolean }) {
  return (
    <div className={`alert ${ok ? 'ok' : ''}`} role={ok ? 'status' : 'alert'}>
      {ok ? <CheckCircle2 size={18} /> : <AlertCircle size={18} />}
      <div><b>{title}</b>{detail}</div>
    </div>
  );
}

/* ------------------------------------------------------------------ pages */

export function LoginPage() {
  const login = useAuth((s) => s.login);
  const nav = useNavigate();
  const loc = useLocation() as { state?: { from?: string } };
  const [email, setEmail] = useState(() => { try { return localStorage.getItem('perfmon.lastEmail') ?? ''; } catch { return ''; } });
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [caps, setCaps] = useState(false);
  const [remember, setRemember] = useState(true);
  const [error, setError] = useState<{ title: string; detail: string } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<'idle' | 'busy' | 'done'>('idle');
  const cfg = useQuery({ queryKey: ['auth-config'], queryFn: () => api.get<{ demo?: { email: string; password?: string } | null }>('/auth/config'), retry: false, staleTime: Infinity });

  const typeInto = async (setter: (v: string) => void, value: string) => {
    if (reducedMotion()) return setter(value);
    for (let i = 1; i <= value.length; i++) { setter(value.slice(0, i)); await new Promise((r) => setTimeout(r, 22)); }
  };
  const useDemo = async () => {
    const d = cfg.data?.demo;
    if (!d) return;
    setError(null);
    setPassword('');
    await typeInto(setEmail, d.email);
    if (d.password) await typeInto(setPassword, d.password);
    else document.getElementById('password')?.focus();
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setState('busy');
    setError(null);
    try {
      await login(email.trim(), password);
      try { remember ? localStorage.setItem('perfmon.lastEmail', email.trim()) : localStorage.removeItem('perfmon.lastEmail'); } catch { /* ignore */ }
      setState('done');
      setTimeout(() => nav(loc.state?.from ?? '/', { replace: true }), reducedMotion() ? 0 : 650);
    } catch (err) {
      setError(explain(err));
      setAttempt((a) => a + 1);
      setState('idle');
    }
  };

  return (
    <AuthShell>
      <form className="glass" onSubmit={submit}>
        <Logo size={34} animated />
        <h1>Welcome back <span className="wave">👋</span></h1>
        <p className="lead">Sign in to your performance engineering workspace.</p>
        {cfg.data?.demo && (
          <div className="demo">
            <Sparkles size={16} style={{ color: '#8b5cf6', flex: 'none' }} />
            <span>Demo workspace: <span className="mono">{cfg.data.demo.email}</span>{cfg.data.demo.password && <> / <span className="mono">{cfg.data.demo.password}</span></>}</span>
            <button type="button" onClick={useDemo}>Use demo</button>
          </div>
        )}
        {error && <Alert key={attempt} title={error.title} detail={error.detail} />}
        <div className="fl">
          <input id="email" type="email" placeholder=" " autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus={!email} />
          <label htmlFor="email">Work email</label>
          <Mail size={17} className="lead-ico" />
        </div>
        <div className="fl">
          <input id="password" type={show ? 'text' : 'password'} placeholder=" " autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required autoFocus={!!email}
            onKeyUp={(e) => setCaps(e.getModifierState?.('CapsLock') ?? false)} onKeyDown={(e) => setCaps(e.getModifierState?.('CapsLock') ?? false)} />
          <label htmlFor="password">Password</label>
          <KeyRound size={17} className="lead-ico" />
          <button type="button" className="fl-btn" onClick={() => setShow((v) => !v)} aria-label={show ? 'Hide password' : 'Show password'}>{show ? <EyeOff size={18} /> : <Eye size={18} />}</button>
        </div>
        {caps && <div className="caps"><AlertCircle size={13} /> Caps Lock is on</div>}
        <div className="row2">
          <label className="check"><input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} /> Remember me</label>
          <Link to="/forgot-password" className="alink">Forgot password?</Link>
        </div>
        <button className={`cta ${state === 'done' ? 'success' : ''}`} type="submit" disabled={state !== 'idle'}>
          {state === 'busy' && <><span className="spinner" />Signing in…</>}
          {state === 'done' && <><svg className="tick" width="20" height="20" viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" /></svg>Welcome!</>}
          {state === 'idle' && <>Sign in <ArrowRight size={18} className="arrow" /></>}
        </button>
        <div className="divider">or continue with</div>
        <div className="sso">
          <button type="button" disabled title="Enable SSO in Administration → Integrations"><Lock size={15} /> SAML SSO</button>
          <button type="button" disabled title="Enable OIDC in Administration → Integrations"><ShieldCheck size={15} /> OpenID Connect</button>
        </div>
        <div className="foot"><span>© {new Date().getFullYear()} Perfmon</span><span><ShieldCheck size={12} style={{ verticalAlign: -2 }} /> RBAC · audit logged · encrypted secrets</span></div>
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
      <form className="glass" onSubmit={async (e) => { e.preventDefault(); setBusy(true); await api.post('/auth/forgot-password', { email }).catch(() => undefined); setBusy(false); setSent(true); }}>
        <Logo size={34} animated />
        <h1>Reset password</h1>
        <p className="lead">Enter your account email and we'll send you a secure reset link.</p>
        {sent ? <Alert ok title="Check your inbox" detail="If an account exists for that email, a reset link is on its way. It expires in 30 minutes." /> : (
          <>
            <div className="fl"><input id="fp-email" type="email" placeholder=" " value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus /><label htmlFor="fp-email">Work email</label><Mail size={17} className="lead-ico" /></div>
            <button className="cta" type="submit" disabled={busy}>{busy ? <><span className="spinner" />Sending…</> : <>Send reset link <ArrowRight size={18} className="arrow" /></>}</button>
          </>
        )}
        <div className="foot"><Link to="/login" className="alink">← Back to sign in</Link></div>
      </form>
    </AuthShell>
  );
}

export function ResetPasswordPage() {
  const token = new URLSearchParams(window.location.search).get('token') ?? '';
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; title: string; detail?: string } | null>(null);
  const checks = [password.length >= 8, /[A-Za-z]/.test(password), /\d/.test(password)];
  return (
    <AuthShell>
      <form className="glass" onSubmit={async (e) => {
        e.preventDefault();
        try { await api.post('/auth/reset-password', { token, password }); setMsg({ ok: true, title: 'Password updated', detail: 'You can now sign in with your new password.' }); }
        catch (err) { setMsg({ ok: false, ...explain(err) }); }
      }}>
        <Logo size={34} animated />
        <h1>New password</h1>
        <p className="lead">At least 8 characters, with letters and digits.</p>
        {msg && <Alert ok={msg.ok} title={msg.title} detail={msg.detail} />}
        <div className="fl">
          <input id="np" type={show ? 'text' : 'password'} placeholder=" " value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} autoFocus />
          <label htmlFor="np">New password</label><KeyRound size={17} className="lead-ico" />
          <button type="button" className="fl-btn" onClick={() => setShow((v) => !v)} aria-label={show ? 'Hide password' : 'Show password'}>{show ? <EyeOff size={18} /> : <Eye size={18} />}</button>
        </div>
        <div className="row2" style={{ justifyContent: 'flex-start', gap: 14 }}>
          {['8+ characters', 'Letters', 'Digits'].map((l, i) => <span key={l} style={{ color: checks[i] ? '#059669' : 'var(--ink-3)', display: 'inline-flex', gap: 4, alignItems: 'center' }}><CheckCircle2 size={13} />{l}</span>)}
        </div>
        <button className="cta" type="submit" disabled={!checks.every(Boolean)}>Update password <ArrowRight size={18} className="arrow" /></button>
        <div className="foot"><Link to="/login" className="alink">← Back to sign in</Link></div>
      </form>
    </AuthShell>
  );
}
