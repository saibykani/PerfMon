import { useMemo } from 'react';
import { useUi } from '@/stores/ui';
import { seriesColor } from '@/charts/palette';

/* ------------------------------------------------------------------ sparkline */
export function Sparkline({ values, width = 96, height = 24, slot = 0, label, markIndex }: { values: (number | null)[]; width?: number; height?: number; slot?: number | string; label?: string; markIndex?: number | null }) {
  const theme = useUi((s) => s.theme);
  const color = seriesColor(theme, slot);
  const pts = values.map((v, i) => [i, v] as const).filter((p): p is readonly [number, number] => p[1] != null && Number.isFinite(p[1]));
  if (pts.length < 2) return <span className="muted" style={{ fontSize: 11 }}>{pts.length ? 'one run' : '—'}</span>;
  const ys = pts.map((p) => p[1]);
  const min = Math.min(...ys), max = Math.max(...ys);
  const x = (i: number) => 2 + (i / Math.max(1, values.length - 1)) * (width - 4);
  const y = (v: number) => (max === min ? height / 2 : 2 + (1 - (v - min) / (max - min)) * (height - 4));
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`).join(' ');
  const last = pts[pts.length - 1];
  const mark = markIndex != null ? pts.find((p) => p[0] === markIndex) : null;
  return (
    <svg className="inv-spark" width={width} height={height} role="img" aria-label={label ?? `trend from ${min.toFixed(1)} to ${max.toFixed(1)}`}>
      <path d={d} fill="none" stroke={color} strokeWidth={1.6} strokeLinejoin="round" strokeLinecap="round" />
      {mark && <circle cx={x(mark[0])} cy={y(mark[1])} r={3} fill="var(--surface)" stroke="var(--text-2)" strokeWidth={1.4}><title>Baseline</title></circle>}
      <circle cx={x(last[0])} cy={y(last[1])} r={2.4} fill={color} />
    </svg>
  );
}

/* ------------------------------------------------------------------ service map */
export interface MapNode { id: string; name: string; kind: string; health: string; sub?: string; latencyMs?: number | null }
const KIND_RANK: Record<string, number> = { loadgen: 0, gateway: 1, service: 2, cache: 3, queue: 3, database: 3, external: 3 };
const HEALTH_LABEL: Record<string, string> = { HEALTHY: 'Healthy', WARNING: 'Warning', CRITICAL: 'Critical', UNKNOWN: 'Unknown' };
const HEALTH_VAR: Record<string, string> = { HEALTHY: 'var(--pass)', WARNING: 'var(--warn)', CRITICAL: 'var(--fail)', UNKNOWN: 'var(--text-3)' };
const HEALTH_GLYPH: Record<string, string> = { HEALTHY: '✓', WARNING: '!', CRITICAL: '✕', UNKNOWN: '?' };

/** Left→right layered layout by dependency depth (longest path from callers); isolated nodes fall back to their kind tier. */
export function layoutMap(nodes: MapNode[], edges: { source: string; target: string }[]) {
  const ids = new Set(nodes.map((n) => n.id));
  const es = edges.filter((e) => ids.has(e.source) && ids.has(e.target) && e.source !== e.target);
  const linked = new Set(es.flatMap((e) => [e.source, e.target]));
  const depth = new Map<string, number>();
  nodes.forEach((n) => depth.set(n.id, linked.has(n.id) ? 0 : KIND_RANK[n.kind] ?? 2));
  // relax edges (bounded: cycles cannot loop forever)
  for (let i = 0; i < nodes.length; i++) {
    let changed = false;
    for (const e of es) {
      const d = (depth.get(e.source) ?? 0) + 1;
      if (d > (depth.get(e.target) ?? 0) && d < nodes.length + 4) { depth.set(e.target, d); changed = true; }
    }
    if (!changed) break;
  }
  // linked roots: push them to their kind tier when that is to the left of their callees
  const cols = new Map<number, MapNode[]>();
  nodes.forEach((n) => { const d = depth.get(n.id)!; cols.set(d, [...(cols.get(d) ?? []), n]); });
  const order = [...cols.keys()].sort((a, b) => a - b);
  const colIndex = new Map(order.map((d, i) => [d, i]));
  const W = 176, H = 54, GX = 96, GY = 22, PAD = 20;
  const maxRows = Math.max(1, ...[...cols.values()].map((c) => c.length));
  const height = PAD * 2 + maxRows * H + (maxRows - 1) * GY;
  const pos = new Map<string, { x: number; y: number }>();
  for (const [d, list] of cols) {
    const ci = colIndex.get(d)!;
    const colH = list.length * H + (list.length - 1) * GY;
    list.sort((a, b) => (KIND_RANK[a.kind] ?? 2) - (KIND_RANK[b.kind] ?? 2) || a.name.localeCompare(b.name))
      .forEach((n, ri) => pos.set(n.id, { x: PAD + ci * (W + GX), y: (height - colH) / 2 + ri * (H + GY) }));
  }
  return { pos, edges: es, width: PAD * 2 + order.length * W + (order.length - 1) * GX, height, W, H };
}

export function ServiceMap({ nodes, edges, selected, onSelect }: { nodes: MapNode[]; edges: { source: string; target: string }[]; selected?: string | null; onSelect?: (id: string) => void }) {
  const L = useMemo(() => layoutMap(nodes, edges), [nodes, edges]);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  return (
    <div className="inv-map">
      <svg width={Math.max(L.width, 300)} height={L.height} role="group" aria-label="Service map">
        <defs>
          <marker id="inv-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0,0 L10,5 L0,10 z" fill="var(--border-strong)" />
          </marker>
        </defs>
        {L.edges.map((e) => {
          const a = L.pos.get(e.source)!, b = L.pos.get(e.target)!;
          const x1 = a.x + L.W, y1 = a.y + L.H / 2, x2 = b.x - 2, y2 = b.y + L.H / 2;
          const back = x2 <= x1;
          const mx = (x1 + x2) / 2;
          const d = back ? `M${x1},${y1} C${x1 + 60},${y1 - 70} ${x2 - 60},${y2 - 70} ${x2},${y2}` : `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`;
          const lat = byId.get(e.target)?.latencyMs;
          return (
            <g key={`${e.source}-${e.target}`}>
              <path className="edge" d={d} markerEnd="url(#inv-arrow)" />
              {lat != null && Number.isFinite(lat) && <text className="edge-label" x={mx} y={(y1 + y2) / 2 - 5} textAnchor="middle">{lat >= 1000 ? `${(lat / 1000).toFixed(2)} s` : `${Math.round(lat)} ms`}</text>}
            </g>
          );
        })}
        {nodes.map((n) => {
          const p = L.pos.get(n.id)!;
          const c = HEALTH_VAR[n.health] ?? HEALTH_VAR.UNKNOWN;
          return (
            <g key={n.id} className={`node ${selected === n.id ? 'selected' : ''}`} transform={`translate(${p.x},${p.y})`} tabIndex={0} role="button"
              aria-label={`${n.name}, ${n.kind}, health ${HEALTH_LABEL[n.health] ?? n.health}`} onClick={() => onSelect?.(n.id)} onKeyDown={(e) => e.key === 'Enter' && onSelect?.(n.id)}>
              <rect className="box" width={L.W} height={L.H} rx={8} />
              <rect width={4} height={L.H - 12} y={6} x={0} rx={2} fill={c} />
              <circle cx={L.W - 16} cy={16} r={8} fill={c} />
              <text x={L.W - 16} y={19.5} textAnchor="middle" style={{ fill: '#fff', fontSize: 10, fontWeight: 700 }}>{HEALTH_GLYPH[n.health] ?? '?'}</text>
              <text x={14} y={22} fontWeight={600}>{n.name.length > 19 ? `${n.name.slice(0, 18)}…` : n.name}</text>
              <text className="sub" x={14} y={39}>{n.kind}{n.sub ? ` · ${n.sub}` : ''} · {HEALTH_LABEL[n.health] ?? n.health}</text>
              <title>{`${n.name} (${n.kind}) — ${HEALTH_LABEL[n.health] ?? n.health}`}</title>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
