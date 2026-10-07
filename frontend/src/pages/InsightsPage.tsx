import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, Lightbulb, Repeat, Search, X } from 'lucide-react';
import { api } from '@/services/api';
import { useFilters, resolveRange } from '@/stores/filters';
import { useUi } from '@/stores/ui';
import { Card, Empty, ErrorBox, Kpi, Loading, PageHeader } from '@/components/ui';
import { DataTable, type Column } from '@/components/DataTable';
import { GlobalFilterBar } from '@/components/GlobalFilters';
import { fmtDate, fmtNum } from '@/components/format';
import { Chart } from '@/charts/Chart';
import {
  CONFIDENCE_LEVELS, ConfidenceLabel, SeverityBadge, Segmented, confidenceLevel, groupBy, severityRank, useDebounced,
} from '@/components/analysis/shared';
import { InsightCard, affectedOf, categoryLabel, patternOf, type Insight } from '@/components/insights/InsightCard';
import { categoryOption } from '@/components/insights/charts';
import '@/styles/insights.css';

type Sev = 'ALL' | 'CRITICAL' | 'WARNING' | 'INFO';
type GroupKey = 'run' | 'category' | 'severity' | 'test' | 'none';
type View = 'cards' | 'table';
const PAGE = 500;

export function InsightsPage() {
  const f = useFilters();
  const theme = useUi((s) => s.theme);
  const [params, setParams] = useSearchParams();
  const runParam = params.get('run');
  const [sev, setSev] = useState<Sev>('ALL');
  const [cats, setCats] = useState<string[]>([]);
  const [minConf, setMinConf] = useState<number>(-1); // -1 any, else min confidence level (0..3)
  const [group, setGroup] = useState<GroupKey>('run');
  const [view, setView] = useState<View>('cards');
  const [text, setText] = useState('');
  const [pattern, setPattern] = useState<string | null>(null);
  const q = useDebounced(text.trim().toLowerCase(), 200);
  const range = resolveRange(f.timeRange);

  const query = useQuery({
    queryKey: ['insights-all', f.projectId, f.testId, runParam, range?.from && Math.floor(range.from / 60000), range?.to && Math.floor(range.to / 60000)],
    queryFn: () => api.get<{ items: Insight[]; total: number }>('/insights', {
      projectId: f.projectId, testId: f.testId, runId: runParam ?? undefined, pageSize: PAGE,
      from: range ? new Date(range.from).toISOString() : undefined, to: range ? new Date(range.to).toISOString() : undefined,
    }),
    refetchInterval: f.refreshSec ? f.refreshSec * 1000 : false,
    placeholderData: (p) => p,
  });
  const all = query.data?.items ?? [];

  // Filters other than category feed the category pills/chart, so their counts stay meaningful.
  const base = useMemo(() => all.filter((i) => {
    if (sev !== 'ALL' && i.severity !== sev) return false;
    if (minConf >= 0 && confidenceLevel(i.confidenceLabel, i.confidence) < minConf) return false;
    if (pattern && patternOf(i.title) !== pattern) return false;
    if (q) {
      const hay = `${i.title} ${i.description} ${i.runKey} ${i.testName} ${i.component ?? ''} ${(i.evidence ?? []).join(' ')} ${i.recommendations.map((r) => r.title).join(' ')}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  }), [all, sev, minConf, pattern, q]);
  const filtered = useMemo(() => (cats.length ? base.filter((i) => cats.includes(i.category)) : base), [base, cats]);

  const catCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const i of base) m.set(i.category, (m.get(i.category) ?? 0) + 1);
    for (const c of cats) if (!m.has(c)) m.set(c, 0);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [base, cats]);

  const kpi = useMemo(() => ({
    critical: all.filter((i) => i.severity === 'CRITICAL').length,
    warning: all.filter((i) => i.severity === 'WARNING').length,
    runs: new Set(all.map((i) => i.runKey)).size,
    bottlenecks: all.filter((i) => i.category === 'BOTTLENECK' && confidenceLevel(i.confidenceLabel, i.confidence) >= 1).length,
    highRecs: all.reduce((n, i) => n + i.recommendations.filter((r) => r.priority === 'HIGH').length, 0),
  }), [all]);

  /** Findings that recur across runs (same title pattern in ≥ 2 runs). */
  const recurring = useMemo(() => {
    const m = new Map<string, { pattern: string; runs: Set<string>; worst: string; latest: Insight; category: string }>();
    for (const i of all) {
      if (i.category === 'DATA_QUALITY') continue;
      const p = patternOf(i.title);
      const e = m.get(p) ?? { pattern: p, runs: new Set<string>(), worst: i.severity, latest: i, category: i.category };
      e.runs.add(i.runKey);
      if (severityRank(i.severity) < severityRank(e.worst)) e.worst = i.severity;
      if (new Date(i.createdAt) > new Date(e.latest.createdAt)) e.latest = i;
      m.set(p, e);
    }
    return [...m.values()].filter((e) => e.runs.size >= 2)
      .sort((a, b) => severityRank(a.worst) - severityRank(b.worst) || b.runs.size - a.runs.size).slice(0, 6);
  }, [all]);

  const chartOpt = useMemo(() => categoryOption(base, { theme, active: cats }), [base, theme, cats]);
  const toggleCat = (c: string) => setCats((s) => (s.includes(c) ? s.filter((x) => x !== c) : [...s, c]));
  const filtersActive = sev !== 'ALL' || cats.length > 0 || minConf >= 0 || !!q || !!pattern;
  const clearFilters = () => { setSev('ALL'); setCats([]); setMinConf(-1); setText(''); setPattern(null); };
  const loading = query.isLoading;

  return (
    <div className="in-page">
      <PageHeader title="Performance Insights"
        subtitle="Findings and recommendations generated when each run is analysed — latency, errors, SLA, regressions, bottleneck candidates and data quality — across all your runs." />
      <GlobalFilterBar show={['project', 'test', 'time', 'refresh']} extra={runParam && (
        <span className="in-scope">Run <span className="mono">{runParam}</span>
          <button className="btn btn-ghost icon-btn btn-sm" aria-label="Show all runs" onClick={() => setParams((p) => { const n = new URLSearchParams(p); n.delete('run'); return n; }, { replace: true })}><X size={12} /></button>
        </span>
      )} />

      {query.error && <ErrorBox error={query.error} />}
      <div className="kpis">
        <Kpi label="Insights" value={loading ? '…' : fmtNum(all.length)} sub={query.data && query.data.total > all.length ? `latest ${fmtNum(all.length)} of ${fmtNum(query.data.total)}` : 'in range'} />
        <Kpi label="Critical" value={loading ? '…' : fmtNum(kpi.critical)} status={kpi.critical ? 'fail' : null} sub="need attention" onClick={() => setSev('CRITICAL')} />
        <Kpi label="Warnings" value={loading ? '…' : fmtNum(kpi.warning)} status={kpi.warning ? 'warn' : null} onClick={() => setSev('WARNING')} />
        <Kpi label="Runs affected" value={loading ? '…' : fmtNum(kpi.runs)} sub="with ≥1 insight" />
        <Kpi label="Bottleneck candidates" value={loading ? '…' : fmtNum(kpi.bottlenecks)} sub="possible or stronger" onClick={() => { setCats(['BOTTLENECK']); setMinConf(1); }} />
        <Kpi label="High-priority actions" value={loading ? '…' : fmtNum(kpi.highRecs)} sub="recommendations" />
      </div>

      <div className="in-grid">
        <Chart title="Insights by category" subtitle="split by severity · click a bar to filter" height={Math.max(300, 40 + new Set(base.map((i) => i.category)).size * 26)}
          option={chartOpt} loading={loading} empty={!loading && !base.length ? 'No insights to chart' : null}
          onPointClick={(p: any) => p?.data?.category && toggleCat(p.data.category)}
          table={{ columns: ['Category', 'Critical', 'Warning', 'Info'], rows: catCounts.map(([c]) => [categoryLabel(c), ...(['CRITICAL', 'WARNING', 'INFO'] as const).map((s) => base.filter((i) => i.category === c && i.severity === s).length)]) }} />
        <Card title={<><Repeat size={13} /> Recurring across runs</>} bodyClass="in-recur-body">
          {loading ? <Loading height={140} /> : !recurring.length ? <Empty>No finding has repeated in two or more runs in this range.</Empty> : (
            <ul className="in-recur">
              {recurring.map((r) => (
                <li key={r.pattern}>
                  <button type="button" className={`in-recur-item ${pattern === r.pattern ? 'on' : ''}`} onClick={() => setPattern((p) => (p === r.pattern ? null : r.pattern))}
                    title="Show only this finding">
                    <SeverityBadge value={r.worst} compact />
                    <span className="in-recur-title">{r.pattern.includes('#') ? r.pattern.replace(/#/g, 'N') : r.latest.title}</span>
                    <span className="in-recur-n">{r.runs.size} runs</span>
                  </button>
                  <span className="in-recur-meta muted">{categoryLabel(r.category)} · latest <Link className="mono" to={`/runs/${r.latest.runKey}`}>{r.latest.runKey}</Link></span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <div className="in-filters">
        <div className="in-search">
          <Search size={14} aria-hidden />
          <input className="input" value={text} onChange={(e) => setText(e.target.value)} placeholder="Search title, transaction, component, evidence…" aria-label="Search insights" />
          {text && <button className="btn btn-ghost icon-btn btn-sm" onClick={() => setText('')} aria-label="Clear search"><X size={12} /></button>}
        </div>
        <Segmented label="Severity" value={sev} onChange={setSev} options={[
          { key: 'ALL', label: 'Any severity' }, { key: 'CRITICAL', label: 'Critical' }, { key: 'WARNING', label: 'Warning' }, { key: 'INFO', label: 'Info' },
        ]} />
        <select className="select" value={minConf} onChange={(e) => setMinConf(Number(e.target.value))} aria-label="Confidence">
          <option value={-1}>Any confidence</option>
          {CONFIDENCE_LEVELS.slice(0, 3).map((l, k) => <option key={l} value={3 - k}>{k === 0 ? l : `${l} or stronger`}</option>)}
        </select>
        <div className="spacer" />
        <label className="row in-label">Group by
          <select className="select" value={group} onChange={(e) => setGroup(e.target.value as GroupKey)} aria-label="Group by">
            <option value="run">Run</option><option value="category">Category</option><option value="severity">Severity</option><option value="test">Test</option><option value="none">No grouping</option>
          </select>
        </label>
        <Segmented label="View" value={view} onChange={setView} options={[{ key: 'cards', label: 'Cards' }, { key: 'table', label: 'Table' }]} />
      </div>

      {catCounts.length > 0 && (
        <div className="an-pills" aria-label="Categories">
          {catCounts.map(([c, n]) => (
            <button key={c} type="button" className={`an-pill ${cats.includes(c) ? 'on' : ''}`} aria-pressed={cats.includes(c)} onClick={() => toggleCat(c)}>
              {categoryLabel(c)}<span className="n">{n}</span>
            </button>
          ))}
          {filtersActive && <button type="button" className="btn btn-ghost btn-sm" onClick={clearFilters}><X size={12} />Clear filters</button>}
        </div>
      )}
      {pattern && <div className="in-note">Showing only “{pattern.replace(/#/g, 'N')}” <button className="btn btn-ghost btn-sm" onClick={() => setPattern(null)}><X size={12} />Show all</button></div>}

      <div className="row in-count"><span className="muted">{fmtNum(filtered.length)} of {fmtNum(all.length)} insights</span></div>

      {loading ? <Loading height={260} />
        : !filtered.length ? (
          <Card><Empty icon={<Lightbulb size={22} />}>
            {all.length
              ? <>No insights match these filters. <button className="btn btn-ghost btn-sm" onClick={clearFilters}>Clear filters</button></>
              : <>No insights in this time range. Insights are generated automatically when a run completes (or when it is re-analysed from the run page); widen the time range or pick another project.</>}
          </Empty></Card>
        ) : view === 'table' ? <InsightTable items={filtered} onAffected={setText} />
          : <Groups items={filtered} group={group} onAffected={setText} />}

      <p className="muted" style={{ fontSize: 11.5, margin: 0 }}>
        Confidence labels are deliberately conservative: <b>Strong correlation</b> → <b>Likely</b> → <b>Possible bottleneck</b> → <b>Insufficient evidence</b>. Correlation is evidence, not proof of root cause.
      </p>
    </div>
  );
}

const sortInsights = (rows: Insight[]) => [...rows].sort((a, b) => severityRank(a.severity) - severityRank(b.severity) || +new Date(b.createdAt) - +new Date(a.createdAt));

function Groups({ items, group, onAffected }: { items: Insight[]; group: GroupKey; onAffected: (s: string) => void }) {
  const groups = useMemo(() => {
    if (group === 'none') return [['', sortInsights(items)] as [string, Insight[]]];
    const key = (i: Insight) => (group === 'run' ? i.runKey : group === 'category' ? i.category : group === 'severity' ? i.severity : i.testName);
    const g = groupBy(items, key).map(([k, rows]) => [k, sortInsights(rows)] as [string, Insight[]]);
    if (group === 'severity') g.sort((a, b) => severityRank(a[0]) - severityRank(b[0]));
    else if (group !== 'run') g.sort((a, b) => b[1].length - a[1].length);
    return g;
  }, [items, group]);
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
  const [expandAll, setExpandAll] = useState(false);
  if (group === 'none') return <div className="an-feed">{groups[0][1].map((i) => <InsightCard key={i.id} insight={i} onAffected={onAffected} />)}</div>;
  const isOpen = (k: string, idx: number) => overrides[k] ?? (expandAll || idx < 6);
  const toggle = (k: string, open: boolean) => setOverrides((o) => ({ ...o, [k]: !open }));
  return (
    <div className="an-feed">
      {groups.length > 6 && !expandAll && <div className="row"><span className="muted">{groups.length} groups — showing the first 6 expanded.</span><button className="btn btn-ghost btn-sm" onClick={() => { setExpandAll(true); setOverrides({}); }}>Expand all</button></div>}
      {groups.map(([k, rows], idx) => {
        const open = isOpen(k, idx);
        const first = rows[0];
        const crit = rows.filter((r) => r.severity === 'CRITICAL').length;
        const warn = rows.filter((r) => r.severity === 'WARNING').length;
        const recs = rows.reduce((n, r) => n + r.recommendations.length, 0);
        return (
          <section key={k} className="an-rungroup">
            <div className="an-rungroup-head" role="button" tabIndex={0} aria-expanded={open} onClick={() => toggle(k, open)} onKeyDown={(e) => e.key === 'Enter' && toggle(k, open)}>
              {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              {group === 'run' ? <>
                <Link to={`/runs/${k}`} className="mono" style={{ fontWeight: 600 }} onClick={(e) => e.stopPropagation()}>{k}</Link>
                <span>{first.testName}</span>
              </> : group === 'severity' ? <SeverityBadge value={k} /> : <b>{group === 'category' ? categoryLabel(k) : k}</b>}
              <div className="spacer" />
              {group !== 'severity' && crit > 0 && <span className="badge fail">{crit} critical</span>}
              {group !== 'severity' && warn > 0 && <span className="badge warn">{warn} warning{warn > 1 ? 's' : ''}</span>}
              <span className="badge">{rows.length} insight{rows.length > 1 ? 's' : ''}</span>
              {recs > 0 && <span className="muted" style={{ fontSize: 11 }}>{recs} recommendation{recs > 1 ? 's' : ''}</span>}
              {group === 'run' && <span className="muted" style={{ fontSize: 11 }}>{fmtDate(first.createdAt)}</span>}
            </div>
            {open && <div className="an-rungroup-body">{rows.map((i) => <InsightCard key={i.id} insight={i} showRun={group !== 'run'} onAffected={onAffected} />)}</div>}
          </section>
        );
      })}
    </div>
  );
}

function InsightTable({ items, onAffected }: { items: Insight[]; onAffected: (s: string) => void }) {
  const cols: Column<Insight>[] = [
    { key: 'severity', header: 'Severity', width: 110, value: (i) => severityRank(i.severity), render: (i) => <SeverityBadge value={i.severity} /> },
    { key: 'category', header: 'Category', width: 120, value: (i) => categoryLabel(i.category) },
    {
      key: 'title', header: 'Insight', value: (i) => i.title,
      render: (i) => <div className="in-cell"><span className="in-cell-title">{i.title}</span><span className="in-cell-desc">{i.description}</span></div>,
    },
    { key: 'confidence', header: 'Confidence', width: 190, value: (i) => confidenceLevel(i.confidenceLabel, i.confidence), render: (i) => <ConfidenceLabel label={i.confidenceLabel} confidence={i.confidence} /> },
    {
      key: 'affected', header: 'Affected', width: 180, value: (i) => affectedOf(i)?.name ?? null,
      render: (i) => { const a = affectedOf(i); return a ? <button type="button" className="in-link" onClick={(e) => { e.stopPropagation(); onAffected(a.name); }} title={a.kind}>{a.name}</button> : <span className="muted">—</span>; },
    },
    { key: 'run', header: 'Run', width: 180, value: (i) => i.runKey, render: (i) => <Link className="mono" to={`/runs/${i.runKey}`}>{i.runKey}</Link> },
    { key: 'test', header: 'Test', width: 140, value: (i) => i.testName },
    { key: 'recs', header: 'Recs', width: 60, align: 'right', value: (i) => i.recommendations.length },
    { key: 'evidence', header: 'Evidence', value: (i) => (i.evidence ?? []).join(' | '), hidden: true },
    { key: 'createdAt', header: 'Created', width: 150, value: (i) => +new Date(i.createdAt), render: (i) => fmtDate(i.createdAt) },
  ];
  return (
    <section className="card">
      <DataTable rows={items} columns={cols} rowKey={(i) => i.id} exportName="insights" searchable={false} initialSort={{ key: 'severity', order: 'asc' }} />
    </section>
  );
}

