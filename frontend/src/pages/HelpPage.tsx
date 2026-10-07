import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import {
  ArrowLeft, ArrowRight, BookOpen, Cpu, Database, Download, ExternalLink, FileCode2, FlaskConical, KeyRound, Rocket, Search, Server, X,
} from 'lucide-react';
import { API_BASE } from '@/services/api';
import '@/styles/help.css';

/* ------------------------------------------------------------------ content */

// Every chapter of the user manual is bundled with this (lazy-loaded) page.
const RAW = import.meta.glob('../../../docs/user-manual/*.md', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

interface Chapter { file: string; num: string; slug: string; title: string; group: string; body: string; text: string }

const GROUPS: { name: string; test: (n: number, file: string) => boolean }[] = [
  { name: 'Get started', test: (n) => n <= 2 },
  { name: 'Inventory & runs', test: (n) => n >= 3 && n <= 8 },
  { name: 'JMeter & results', test: (n) => n >= 9 && n <= 12 },
  { name: 'Observability', test: (n) => n >= 13 && n <= 19 },
  { name: 'Analysis', test: (n) => n >= 20 && n <= 27 },
  { name: 'Reporting & automation', test: () => true },
];

/** Links to chapters that were merged into others. */
const ALIASES: Record<string, string> = {
  '31-influxdb-integration': 'influxdb-setup',
  '41-jmeter-integration-examples': 'jmeter-setup',
  '42-ci-cd-examples': 'ci-cd-integration',
};

const CHAPTERS: Chapter[] = Object.entries(RAW).map(([path, body]) => {
  const file = path.split('/').pop()!.replace(/\.md$/, '');
  const m = /^(\d+[a-z]?)-(.+)$/.exec(file);
  const num = m?.[1] ?? '99';
  const n = parseInt(num, 10);
  const title = /^#\s+(.+)$/m.exec(body)?.[1].trim() ?? file;
  const text = body.replace(/```[\s\S]*?```/g, ' ').replace(/[#>*_`|[\]()-]/g, ' ').replace(/\s+/g, ' ');
  return { file, num, slug: m?.[2] ?? file, title, group: GROUPS.find((g) => g.test(n, file))!.name, body, text };
}).sort((a, b) => a.num.localeCompare(b.num, undefined, { numeric: true }));

const BY_FILE = new Map(CHAPTERS.map((c) => [c.file, c]));
const BY_SLUG = new Map(CHAPTERS.map((c) => [c.slug, c]));

const SAMPLES = [
  { file: 'perfmon-sample-test.jmx', title: 'Sample JMeter test plan', desc: 'Thread group driven by properties, 3 HTTP requests and the Perfmon Backend Listener.', icon: FlaskConical },
  { file: 'run-perfmon-test.sh', title: 'Run script — Linux / macOS', desc: 'Creates the run, runs JMeter, uploads JTL + HTML report, completes the run.', icon: FileCode2 },
  { file: 'run-perfmon-test.ps1', title: 'Run script — Windows PowerShell', desc: 'The same wrapper for Windows load generators and CI agents.', icon: FileCode2 },
  { file: 'user.properties', title: 'JMeter user.properties', desc: 'perfmon.url, send interval and the sample load profile.', icon: FileCode2 },
  { file: 'influxdb-grafana-compose.yml', title: 'InfluxDB 1.8 + Grafana (Docker)', desc: 'Optional stack for teams that also want JMeter data in Grafana.', icon: Database },
  { file: 'perfmon-collector.service', title: 'Collector systemd service', desc: 'Runs the Perfmon Collector on Linux servers under test.', icon: Server },
];

const GUIDES = [
  { slug: 'quick-start', icon: Rocket, blurb: 'Zero to a live JMeter test in about 20 minutes.' },
  { slug: 'prerequisites-and-hosts', icon: Server, blurb: 'Install with Docker, hosts, ports, firewall rules.' },
  { slug: 'jmeter-setup', icon: FlaskConical, blurb: 'Java, JMeter, the Backend Listener and run scripts.' },
  { slug: 'influxdb-setup', icon: Database, blurb: 'Two listeners, or import JMeter results from your InfluxDB.' },
  { slug: 'server-monitoring', icon: Cpu, blurb: 'Collector on app servers and the System Monitor.' },
  { slug: 'users-and-api-keys', icon: KeyRound, blurb: 'Invite users, roles, API keys for JMeter and CI.' },
];

/* ------------------------------------------------------------------ rendering */

const slugify = (s: string) => s.toLowerCase().replace(/<[^>]+>/g, '').replace(/&[a-z]+;/g, '').replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-');

/** Rewrites chapter links (`07-running-tests.md#x`) to app routes; unknown chapters become plain text. */
function rewriteLinks(md: string) {
  return md.replace(/\]\((\d+[a-z]?-[\w-]+)\.md(#[\w-]+)?\)/g, (_all, file: string, hash = '') => {
    const target = BY_FILE.get(file)?.slug ?? ALIASES[file];
    return target ? `](/help/${target}${hash})` : `](#missing:${file})`;
  });
}

function renderChapter(c: Chapter) {
  const html = marked.parse(rewriteLinks(c.body), { async: false, gfm: true }) as string;
  return DOMPurify.sanitize(html, { ADD_ATTR: ['target'] });
}

function Article({ chapter, onToc }: { chapter: Chapter; onToc: (t: { id: string; text: string; level: number }[]) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const nav = useNavigate();
  const html = useMemo(() => renderChapter(chapter), [chapter]);
  const loc = useLocation();

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const toc: { id: string; text: string; level: number }[] = [];
    const used = new Set<string>();
    el.querySelectorAll('h1, h2, h3').forEach((h) => {
      let id = slugify(h.textContent ?? '');
      while (used.has(id)) id += '-1';
      used.add(id);
      h.id = id;
      if (h.tagName !== 'H1') toc.push({ id, text: h.textContent ?? '', level: h.tagName === 'H2' ? 2 : 3 });
    });
    onToc(toc);
    el.querySelectorAll('pre').forEach((pre) => {
      if (pre.querySelector('.copy')) return;
      const b = document.createElement('button');
      b.className = 'copy'; b.type = 'button'; b.textContent = 'Copy';
      b.onclick = async () => {
        try { await navigator.clipboard.writeText(pre.querySelector('code')?.textContent ?? pre.textContent ?? ''); b.textContent = 'Copied'; }
        catch { b.textContent = 'Press Ctrl+C'; }
        setTimeout(() => (b.textContent = 'Copy'), 1500);
      };
      pre.appendChild(b);
    });
    el.querySelectorAll('a[href^="#missing:"]').forEach((a) => {
      const span = document.createElement('span');
      span.className = 'doc-missing'; span.title = 'This chapter has not been written yet';
      span.textContent = a.textContent; a.replaceWith(span);
    });
    el.querySelectorAll('a[href^="http"]').forEach((a) => { a.setAttribute('target', '_blank'); a.setAttribute('rel', 'noreferrer'); });
    el.querySelectorAll('img').forEach((img) => { img.loading = 'lazy'; img.onerror = () => img.closest('p')?.classList.add('img-missing'); });
  }, [html, onToc]);

  // scroll to the #anchor (or top) when the chapter or hash changes
  useEffect(() => {
    const id = decodeURIComponent(loc.hash.slice(1));
    const target = id ? document.getElementById(id) : null;
    if (target) target.scrollIntoView({ block: 'start' });
    else document.querySelector('.help-main')?.scrollTo({ top: 0 });
  }, [chapter.slug, loc.hash, html]);

  const onClick = (e: React.MouseEvent) => {
    const a = (e.target as HTMLElement).closest('a');
    const href = a?.getAttribute('href');
    if (!a || !href || e.ctrlKey || e.metaKey) return;
    if (href.startsWith('/help')) { e.preventDefault(); nav(href); }
    else if (href.startsWith('#')) { e.preventDefault(); nav({ hash: href }); }
  };

  return <div ref={ref} className="doc" onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />;
}

/* ------------------------------------------------------------------ search */

function useSearch(q: string) {
  return useMemo(() => {
    const terms = q.toLowerCase().split(/\s+/).filter((t) => t.length > 1);
    if (!terms.length) return [];
    return CHAPTERS.map((c) => {
      const t = c.title.toLowerCase();
      const body = c.text.toLowerCase();
      let score = 0;
      for (const term of terms) {
        if (t.includes(term)) score += 10;
        const n = body.split(term).length - 1;
        if (!n) return null;
        score += Math.min(n, 20);
      }
      const at = body.indexOf(terms[0]);
      const snippet = c.text.slice(Math.max(0, at - 70), at + 150).trim();
      return { c, score, snippet };
    }).filter(Boolean).sort((a, b) => b!.score - a!.score).slice(0, 12) as { c: Chapter; score: number; snippet: string }[];
  }, [q]);
}

function Highlight({ text, q }: { text: string; q: string }) {
  const terms = q.split(/\s+/).filter((t) => t.length > 1).map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (!terms.length) return <>{text}</>;
  const parts = text.split(new RegExp(`(${terms.join('|')})`, 'ig'));
  return <>{parts.map((p, i) => (i % 2 ? <mark key={i}>{p}</mark> : p))}</>;
}

/* ------------------------------------------------------------------ page */

function SearchBox({ q, setQ, autoFocus }: { q: string; setQ: (v: string) => void; autoFocus?: boolean }) {
  return (
    <div className="help-search">
      <Search size={16} />
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search the documentation — e.g. backend listener, InfluxDB, API key" autoFocus={autoFocus} aria-label="Search documentation" />
      {q && <button onClick={() => setQ('')} aria-label="Clear search"><X size={14} /></button>}
    </div>
  );
}

function Results({ q }: { q: string }) {
  const results = useSearch(q);
  return (
    <div className="help-results">
      <div className="muted small">{results.length ? `${results.length} chapter${results.length > 1 ? 's' : ''} match` : 'No chapter matches — try fewer or different words.'}</div>
      {results.map(({ c, snippet }) => (
        <Link key={c.slug} to={`/help/${c.slug}`} className="help-result">
          <b><Highlight text={c.title} q={q} /></b>
          <span className="muted small">{c.group}</span>
          <p>…<Highlight text={snippet} q={q} />…</p>
        </Link>
      ))}
    </div>
  );
}

function Home() {
  const [q, setQ] = useState('');
  return (
    <div className="help-home">
      <section className="help-hero">
        <div className="help-hero-ico"><BookOpen size={22} /></div>
        <h1>Help &amp; Documentation</h1>
        <p>Everything to set Perfmon up end to end — install, connect JMeter, optional InfluxDB and Grafana, server monitoring, users and API keys — plus the full user manual.</p>
        <SearchBox q={q} setQ={setQ} autoFocus />
      </section>
      {q ? <Results q={q} /> : <>
        <h2 className="help-h">Set up Perfmon end to end</h2>
        <div className="help-guides">
          {GUIDES.map((g, i) => {
            const c = BY_SLUG.get(g.slug);
            if (!c) return null;
            return (
              <Link key={g.slug} to={`/help/${g.slug}`} className="help-guide">
                <span className="help-step">{i + 1}</span>
                <g.icon size={20} className="help-guide-ico" />
                <b>{c.title.replace(/:.*$/, '')}</b>
                <span>{g.blurb}</span>
              </Link>
            );
          })}
        </div>

        <h2 className="help-h">Downloads</h2>
        <div className="help-downloads">
          {SAMPLES.map((s) => (
            <a key={s.file} href={`/samples/${s.file}`} download className="help-dl">
              <s.icon size={18} />
              <div><b>{s.title}</b><span className="mono">{s.file}</span><p>{s.desc}</p></div>
              <Download size={15} className="help-dl-arrow" />
            </a>
          ))}
        </div>

        <h2 className="help-h">User manual</h2>
        <div className="help-manual">
          {GROUPS.map((g) => {
            const list = CHAPTERS.filter((c) => c.group === g.name);
            if (!list.length) return null;
            return (
              <div key={g.name} className="help-manual-group">
                <h3>{g.name}</h3>
                {list.map((c) => <Link key={c.slug} to={`/help/${c.slug}`}>{c.title}</Link>)}
              </div>
            );
          })}
          <div className="help-manual-group">
            <h3>Reference</h3>
            <a href={`${API_BASE}/api/docs`} target="_blank" rel="noreferrer">API reference (Swagger) <ExternalLink size={11} /></a>
            <a href="https://jmeter.apache.org/usermanual/component_reference.html#Backend_Listener" target="_blank" rel="noreferrer">JMeter Backend Listener <ExternalLink size={11} /></a>
          </div>
        </div>
      </>}
    </div>
  );
}

function ChapterView({ chapter }: { chapter: Chapter }) {
  const [q, setQ] = useState('');
  const [toc, setToc] = useState<{ id: string; text: string; level: number }[]>([]);
  const idx = CHAPTERS.indexOf(chapter);
  const prev = CHAPTERS[idx - 1];
  const next = CHAPTERS[idx + 1];
  let lastGroup = '';
  return (
    <div className="help-layout">
      <aside className="help-side">
        <Link to="/help" className="help-back"><ArrowLeft size={13} />Documentation home</Link>
        <SearchBox q={q} setQ={setQ} />
        <nav aria-label="Chapters">
          {CHAPTERS.map((c) => {
            const head = c.group !== lastGroup ? (lastGroup = c.group) : null;
            return (
              <div key={c.slug}>
                {head && <div className="help-side-group">{head}</div>}
                <Link to={`/help/${c.slug}`} className={c === chapter ? 'on' : ''}>{c.title.replace(/:.*$/, '')}</Link>
              </div>
            );
          })}
        </nav>
      </aside>
      <main className="help-main">
        {q ? <Results q={q} /> : <>
          <div className="help-crumb muted small"><Link to="/help">Documentation</Link> / {chapter.group}</div>
          <Article chapter={chapter} onToc={setToc} />
          <div className="help-pager">
            {prev ? <Link to={`/help/${prev.slug}`}><span className="muted small">Previous</span><b><ArrowLeft size={13} />{prev.title}</b></Link> : <span />}
            {next ? <Link to={`/help/${next.slug}`} className="r"><span className="muted small">Next</span><b>{next.title}<ArrowRight size={13} /></b></Link> : <span />}
          </div>
        </>}
      </main>
      {!q && toc.length > 2 && (
        <aside className="help-toc" aria-label="On this page">
          <div className="help-toc-h">On this page</div>
          {toc.map((t) => <a key={t.id} href={`#${t.id}`} className={t.level === 3 ? 'l3' : ''}>{t.text}</a>)}
        </aside>
      )}
    </div>
  );
}

export function HelpPage() {
  const { section } = useParams<{ section?: string }>();
  if (!section) return <Home />;
  const chapter = BY_SLUG.get(section);
  if (!chapter) {
    return <NotFound>No chapter called “{section}”. <Link to="/help">Back to the documentation</Link></NotFound>;
  }
  return <ChapterView chapter={chapter} />;
}

const NotFound = ({ children }: { children: ReactNode }) => <div className="empty">{children}</div>;
