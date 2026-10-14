import { useMemo, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Activity, ArrowRight, Boxes, ChevronRight, Compass, Cpu, Database, FlaskConical, Gauge, Server, type LucideIcon } from 'lucide-react';
import { PageHeader } from '@/components/ui';
import { useObsFilters, useObsRange } from '@/stores/obsFilters';
import { ObsFilterBar, ROLE_LABEL } from '@/components/observability/ObsFilterBar';
import { PRESETS } from '@/components/observability/ObsWindow';
import { encodePanels } from '@/components/observability/obsViews';
import { useObsInventory, useObsSeries, useObsTable, type ObsQuery, type ObsTableRow } from '@/components/observability/obsApi';
import { formatTs, writeUrlState, type FilterKey, type ObsFilterValues } from '@/components/observability/obsTime';
import '@/styles/observability.css';
import '@/styles/apm.css';

/* ------------------------------------------------------------------ health rules */

type Level = 'ok' | 'warn' | 'crit' | 'none';
const LEVEL_TEXT: Record<Level, string> = { ok: 'Healthy', warn: 'Warning', crit: 'Critical', none: 'No data' };
const RANK: Record<Level, number> = { none: 0, ok: 1, warn: 2, crit: 3 };
const worst = (ls: Level[]): Level => ls.reduce<Level>((a, b) => (RANK[b] > RANK[a] ? b : a), 'none');

/**
 * Health is judged on the P95 of the window (robust to single spikes); the card still shows
 * the peak with its value so short spikes stay visible. Load generators use the platform's
 * default load-generator thresholds (Administration → Settings).
 */
interface Rule { warn: number; crit: number; higherIsWorse?: boolean }
const RULES: Record<string, Rule> = {
  'host.cpu_pct': { warn: 80, crit: 90 }, 'host.memory_pct': { warn: 85, crit: 95 }, 'host.disk_pct': { warn: 80, crit: 90 },
  'loadgen.host.cpu_pct': { warn: 75, crit: 90 }, 'loadgen.host.memory_pct': { warn: 80, crit: 90 },
  'svc.error_pct': { warn: 1, crit: 5 }, 'svc.cpu_pct': { warn: 80, crit: 90 },
  'jvm.heap_pct': { warn: 85, crit: 95 }, 'jvm.gc_pause_ms': { warn: 200, crit: 500 },
  'db.pool_pct': { warn: 75, crit: 90 }, 'db.cpu_pct': { warn: 80, crit: 90 }, 'db.deadlocks': { warn: 1, crit: 5 },
  'k8s.pod.restarts': { warn: 1, crit: 3 },
  'run.error_pct': { warn: 1, crit: 5 },
};
function levelOf(ruleKey: string, v: number | null | undefined): Level {
  const r = RULES[ruleKey];
  if (!r || v == null || !Number.isFinite(v)) return 'none';
  return v >= r.crit ? 'crit' : v >= r.warn ? 'warn' : 'ok';
}

/* ------------------------------------------------------------------ tiers */

interface Tier {
  key: string; title: string; short: string; icon: LucideIcon; preset: keyof typeof PRESETS; entityFilter: FilterKey;
  metrics: string[];            // shown on cards, first = sparkline
  filters?: ObsFilterValues;    // tier-specific filters (e.g. role)
  rulePrefix?: string;          // rule namespace (load generators use their own thresholds)
  keep?: (row: ObsTableRow, roleOf: Map<string, string | null | undefined>) => boolean;
}
const isLoadgen = (id: string | null, roleOf: Map<string, string | null | undefined>) => (roleOf.get(id ?? '') ?? '').toLowerCase() === 'loadgen';

const TIERS: Tier[] = [
  { key: 'loadgen', title: 'Load generators', short: 'Load generators', icon: FlaskConical, preset: 'loadgen', entityFilter: 'hostId', rulePrefix: 'loadgen.',
    metrics: ['host.cpu_pct', 'host.memory_pct', 'host.disk_pct', 'host.net_tx_kbps'], filters: { role: ['loadgen'] } },
  { key: 'hosts', title: 'Application & infrastructure servers', short: 'Servers', icon: Server, preset: 'hosts', entityFilter: 'hostId',
    metrics: ['host.cpu_pct', 'host.memory_pct', 'host.disk_pct', 'host.load_1m'], keep: (r, roleOf) => !isLoadgen(r.entityId, roleOf) },
  { key: 'services', title: 'Services', short: 'Services', icon: Activity, preset: 'services', entityFilter: 'serviceId',
    metrics: ['svc.request_rate', 'svc.latency_ms', 'svc.error_pct', 'svc.cpu_pct'] },
  { key: 'jvm', title: 'JVM', short: 'JVM', icon: Cpu, preset: 'services', entityFilter: 'serviceId',
    metrics: ['jvm.heap_pct', 'jvm.gc_pause_ms', 'jvm.threads', 'jvm.heap_used_mb'] },
  { key: 'databases', title: 'Databases', short: 'Databases', icon: Database, preset: 'databases', entityFilter: 'databaseId',
    metrics: ['db.query_latency_ms', 'db.connections_active', 'db.pool_pct', 'db.cpu_pct', 'db.slow_queries', 'db.deadlocks'] },
  { key: 'k8s', title: 'Kubernetes pods', short: 'Kubernetes', icon: Boxes, preset: 'k8s', entityFilter: 'pod',
    metrics: ['k8s.pod.cpu_millicores', 'k8s.pod.memory_mb', 'k8s.pod.restarts'] },
];

const fmt = (v: number | null | undefined, unit?: string | null) => {
  if (v == null || !Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  const n = a >= 1000 ? v.toLocaleString(undefined, { maximumFractionDigits: 0 }) : a >= 100 ? v.toFixed(0) : a >= 10 ? v.toFixed(1) : v.toFixed(2);
  return unit ? `${n} ${unit}` : n;
};

/* ------------------------------------------------------------------ data */

interface Entity { id: string; label: string; rows: Record<string, ObsTableRow>; level: Level; reasons: string[] }

function useTier(t: Tier, q: ObsQuery, roleOf: Map<string, string | null | undefined>) {
  const tq: ObsQuery = useMemo(() => ({ ...q, filters: { ...q.filters, ...(t.filters ?? {}) } }), [q, t.filters]);
  const table = useObsTable(tq, { metrics: t.metrics, limit: 50 });
  const spark = useObsSeries(tq, { metrics: [t.metrics[0]], limit: 50 });
  const entities = useMemo<Entity[]>(() => {
    const by = new Map<string, Entity>();
    for (const r of table.data?.rows ?? []) {
      if (t.keep && !t.keep(r, roleOf)) continue;
      const id = r.entityId ?? r.label;
      const e = by.get(id) ?? { id, label: r.label, rows: {}, level: 'none' as Level, reasons: [] };
      e.rows[r.metric] = r;
      by.set(id, e);
    }
    for (const e of by.values()) {
      const levels: Level[] = [];
      for (const [m, r] of Object.entries(e.rows)) {
        if (!r.stats.samples) continue;
        const l = levelOf((t.rulePrefix ?? '') + m in RULES ? (t.rulePrefix ?? '') + m : m, r.stats.p95 ?? r.stats.max);
        levels.push(l === 'none' ? 'ok' : l);
        if (l === 'warn' || l === 'crit') e.reasons.push(`${m.split('.').pop()?.replace(/_/g, ' ')} p95 ${fmt(r.stats.p95, r.unit)}`);
      }
      e.level = levels.length ? worst(levels) : 'none';
    }
    return [...by.values()].sort((a, b) => RANK[b.level] - RANK[a.level] || a.label.localeCompare(b.label));
  }, [table.data, roleOf, t]);
  const sparks = useMemo(() => {
    const m = new Map<string, [number, number | null][]>();
    for (const s of spark.data?.series ?? []) m.set(s.entityId ?? s.label, s.points);
    return m;
  }, [spark.data]);
  return { entities, sparks, loading: table.isLoading, error: table.error as Error | null };
}

/* ------------------------------------------------------------------ pieces */

function Spark({ points }: { points?: [number, number | null][] }) {
  const vals = (points ?? []).map((p) => p[1]).filter((v): v is number => v != null);
  if (vals.length < 2) return <div className="apm-spark empty">no trend</div>;
  const min = Math.min(...vals), max = Math.max(...vals), span = max - min || 1;
  const n = points!.length;
  let d = '', pen = false;
  points!.forEach(([, v], i) => {
    if (v == null) { pen = false; return; }
    const x = (i / (n - 1)) * 100, y = 26 - ((v - min) / span) * 24;
    d += `${pen ? 'L' : 'M'}${x.toFixed(2)},${y.toFixed(2)} `; pen = true;
  });
  return <svg className="apm-spark" viewBox="0 0 100 28" preserveAspectRatio="none" aria-hidden="true"><path d={d} /></svg>;
}

const Chip = ({ level }: { level: Level }) => <span className={`apm-chip lv-${level}`}><i />{LEVEL_TEXT[level]}</span>;

function explorerLink(t: Tier, entityId?: string) {
  const st = useObsFilters.getState();
  const filters: ObsFilterValues = { ...st.filters, ...(t.filters ?? {}) };
  if (entityId) filters[t.entityFilter] = [entityId];
  const sp = writeUrlState({ ...st, filters });
  sp.set('panels', encodePanels(PRESETS[t.preset].panels()));
  return `/observability?${sp.toString()}`;
}

function EntityCard({ t, e, spark, roleOf, tz }: { t: Tier; e: Entity; spark?: [number, number | null][]; roleOf: Map<string, string | null | undefined>; tz: 'local' | 'utc' }) {
  const primary = e.rows[t.metrics[0]];
  const role = roleOf.get(e.id);
  return (
    <Link to={explorerLink(t, e.id)} className={`apm-card lv-${e.level}`} title="Open in the Explorer">
      <div className="apm-card-head">
        <div className="apm-card-name"><b>{e.label}</b>{role && t.key !== 'loadgen' && <span className="apm-role">{ROLE_LABEL[role] ?? role}</span>}</div>
        <Chip level={e.level} />
      </div>
      <div className="apm-metrics">
        {t.metrics.map((m) => {
          const r = e.rows[m];
          if (!r) return null;
          const lv = levelOf((t.rulePrefix ?? '') + m in RULES ? (t.rulePrefix ?? '') + m : m, r.stats.p95 ?? r.stats.max);
          return (
            <div key={m} className={`apm-m lv-${lv}`}>
              <span>{r.metric.startsWith('host.net') ? 'Net out' : labelOf(m)}</span>
              <b className="num">{fmt(r.stats.avg, r.unit)}</b>
              <em className="num" title={r.stats.max != null && (r.stats as any).maxTs ? `peak at ${formatTs(Date.parse((r.stats as any).maxTs), tz)}` : undefined}>peak {fmt(r.stats.max, r.unit)}</em>
            </div>
          );
        })}
      </div>
      <Spark points={spark} />
      <div className="apm-card-foot">
        <span>{primary ? `${labelOf(t.metrics[0])} · ${primary.stats.samples.toLocaleString()} samples` : 'No samples'}</span>
        {e.reasons.length > 0 && <span className="apm-reason">{e.reasons[0]}</span>}
      </div>
    </Link>
  );
}

const LABELS: Record<string, string> = {
  'host.cpu_pct': 'CPU', 'host.memory_pct': 'Memory', 'host.disk_pct': 'Disk', 'host.load_1m': 'Load 1m', 'host.net_tx_kbps': 'Net out',
  'svc.request_rate': 'Requests', 'svc.latency_ms': 'Latency', 'svc.error_pct': 'Errors', 'svc.cpu_pct': 'CPU',
  'jvm.heap_pct': 'Heap', 'jvm.gc_pause_ms': 'GC pause', 'jvm.threads': 'Threads', 'jvm.heap_used_mb': 'Heap used',
  'db.query_latency_ms': 'Query latency', 'db.connections_active': 'Connections', 'db.pool_pct': 'Pool', 'db.cpu_pct': 'CPU', 'db.slow_queries': 'Slow queries', 'db.deadlocks': 'Deadlocks',
  'k8s.pod.cpu_millicores': 'CPU', 'k8s.pod.memory_mb': 'Memory', 'k8s.pod.restarts': 'Restarts',
  'run.tps': 'Throughput', 'run.p95_ms': 'P95', 'run.error_pct': 'Errors', 'run.active_users': 'Users',
};
const labelOf = (m: string) => LABELS[m] ?? m;

/* ------------------------------------------------------------------ page */

function TierSection({ t, q, roleOf, tz, onSummary }: { t: Tier; q: ObsQuery; roleOf: Map<string, string | null | undefined>; tz: 'local' | 'utc'; onSummary?: ReactNode }) {
  const d = useTier(t, q, roleOf);
  const counts = { crit: 0, warn: 0, ok: 0, none: 0 } as Record<Level, number>;
  d.entities.forEach((e) => { counts[e.level]++; });
  return (
    <section className="apm-tier" id={`tier-${t.key}`}>
      <div className="apm-tier-head">
        <h2><t.icon size={16} />{t.title}<span className="muted">{d.entities.length}</span></h2>
        <div className="apm-tier-counts">
          {counts.crit > 0 && <span className="apm-chip lv-crit"><i />{counts.crit} critical</span>}
          {counts.warn > 0 && <span className="apm-chip lv-warn"><i />{counts.warn} warning</span>}
          {counts.ok > 0 && <span className="apm-chip lv-ok"><i />{counts.ok} healthy</span>}
          <Link className="btn btn-sm" to={explorerLink(t)}><Compass size={13} />Explorer</Link>
        </div>
      </div>
      {onSummary}
      {d.error ? <div className="error-box">{d.error.message}</div>
        : d.loading ? <div className="apm-grid">{[0, 1, 2].map((i) => <div key={i} className="skeleton" style={{ height: 168 }} />)}</div>
        : d.entities.length ? <div className="apm-grid">{d.entities.map((e) => <EntityCard key={e.id} t={t} e={e} spark={d.sparks.get(e.id)} roleOf={roleOf} tz={tz} />)}</div>
        : <div className="apm-empty">No {t.title.toLowerCase()} reported data in this window.</div>}
    </section>
  );
}

function TierFlow({ q, roleOf }: { q: ObsQuery; roleOf: Map<string, string | null | undefined> }) {
  return (
    <nav className="apm-flow" aria-label="Tiers">
      {TIERS.map((t, i) => <FlowNode key={t.key} t={t} q={q} roleOf={roleOf} last={i === TIERS.length - 1} />)}
    </nav>
  );
}
function FlowNode({ t, q, roleOf, last }: { t: Tier; q: ObsQuery; roleOf: Map<string, string | null | undefined>; last: boolean }) {
  const d = useTier(t, q, roleOf);
  const level = worst(d.entities.map((e) => e.level));
  return (
    <>
      <a href={`#tier-${t.key}`} className={`apm-node lv-${d.entities.length ? level : 'none'}`}>
        <t.icon size={18} />
        <span className="apm-node-title" title={t.title}>{t.short}</span>
        <b className="num">{d.loading ? '…' : d.entities.length}</b>
        <span className="apm-node-state">{d.entities.length ? LEVEL_TEXT[level] : 'No data'}</span>
      </a>
      {!last && <ChevronRight size={16} className="apm-arrow" aria-hidden="true" />}
    </>
  );
}

function RunsStrip({ q, tz }: { q: ObsQuery; tz: 'local' | 'utc' }) {
  const metrics = ['run.tps', 'run.p95_ms', 'run.error_pct', 'run.active_users'];
  const table = useObsTable(q, { metrics, groupBy: 'none' });
  const inv = useObsInventory(q.from, q.to);
  const rows = Object.fromEntries((table.data?.rows ?? []).map((r) => [r.metric, r]));
  const runs = inv.data?.runs ?? [];
  const errLevel = levelOf('run.error_pct', rows['run.error_pct']?.stats.avg);
  return (
    <section className="apm-runs">
      <div className="apm-runs-head"><Gauge size={16} /><b>Load test traffic in this window</b><span className="muted">{runs.length} run{runs.length === 1 ? '' : 's'}</span>{runs.length > 0 && <Chip level={errLevel === 'none' ? 'ok' : errLevel} />}</div>
      {runs.length ? (
        <>
          <div className="apm-runs-kpis">
            {metrics.map((m) => <div key={m}><span>{labelOf(m)}</span><b className="num">{fmt(rows[m]?.stats.avg, rows[m]?.unit)}</b><em className="num">peak {fmt(rows[m]?.stats.max, rows[m]?.unit)}</em></div>)}
          </div>
          <div className="apm-runs-list">
            {runs.slice(0, 6).map((r) => <Link key={r.id} to={`/runs/${r.runKey}`}><span className="mono">{r.runKey}</span><span>{r.testName}</span><span className="muted">{formatTs(Date.parse(r.startedAt), tz)}</span><ArrowRight size={12} /></Link>)}
            {runs.length > 6 && <span className="muted small">+{runs.length - 6} more</span>}
          </div>
        </>
      ) : <div className="apm-empty">No test runs overlapped this window.</div>}
    </section>
  );
}

export function ApmPage() {
  const { filters, tz } = useObsFilters();
  const { from, to } = useObsRange();
  const inv = useObsInventory(from, to);
  const roleOf = useMemo(() => new Map((inv.data?.hosts ?? []).map((h) => [h.id, h.role])), [inv.data]);
  const q: ObsQuery = useMemo(() => ({ from, to, filters }), [from, to, filters]);
  return (
    <div className="apm-page stack">
      <PageHeader title="APM overview" subtitle="Health of every tier in one place — load generators, servers, services, JVMs, databases and Kubernetes — for the selected window. Health uses each metric's P95; cards show average and peak. Click a card to open it in the Explorer." />
      <ObsFilterBar />
      <TierFlow q={q} roleOf={roleOf} />
      <RunsStrip q={q} tz={tz} />
      {TIERS.map((t) => <TierSection key={t.key} t={t} q={q} roleOf={roleOf} tz={tz} />)}
    </div>
  );
}
