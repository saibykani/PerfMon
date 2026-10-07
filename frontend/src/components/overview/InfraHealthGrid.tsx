import { AlertTriangle, CheckCircle2, HelpCircle, Server, XCircle } from 'lucide-react';
import { useNavigate } from 'react-router-dom';

export interface InfraItem {
  serverId: string; name: string; role: string | null; environmentName: string | null; status: string;
  cpuPct: number | null; memoryPct: number | null; lastSeenAt: string | null;
}

const META: Record<string, { cls: string; label: string; icon: typeof CheckCircle2 }> = {
  HEALTHY: { cls: 'pass', label: 'Healthy', icon: CheckCircle2 },
  WARNING: { cls: 'warn', label: 'Warning', icon: AlertTriangle },
  CRITICAL: { cls: 'fail', label: 'Critical', icon: XCircle },
  UNKNOWN: { cls: 'unknown', label: 'Unknown', icon: HelpCircle },
};

/** Effective status: the server's own status, escalated by the latest CPU / memory sample. */
export function infraStatus(s: InfraItem): keyof typeof META {
  const peak = Math.max(s.cpuPct ?? 0, s.memoryPct ?? 0);
  const base = (META[s.status] ? s.status : 'UNKNOWN') as keyof typeof META;
  const fromLoad = peak >= 90 ? 'CRITICAL' : peak >= 75 ? 'WARNING' : s.cpuPct != null || s.memoryPct != null ? 'HEALTHY' : 'UNKNOWN';
  const rank = { UNKNOWN: 0, HEALTHY: 1, WARNING: 2, CRITICAL: 3 } as const;
  return rank[fromLoad as keyof typeof rank] > rank[base as keyof typeof rank] ? (fromLoad as keyof typeof META) : base;
}

function Meter({ label, v }: { label: string; v: number | null }) {
  const lvl = v == null ? '' : v >= 90 ? 'fail' : v >= 75 ? 'warn' : 'ok';
  return (
    <div className="meter" title={`${label} ${v == null ? 'no data' : `${v.toFixed(1)}%`}`}>
      <span className="meter-l">{label}</span>
      <span className="meter-track"><span className={`meter-fill ${lvl}`} style={{ width: `${Math.min(100, Math.max(0, v ?? 0))}%` }} /></span>
      <span className="meter-v num">{v == null ? '—' : `${Math.round(v)}%`}</span>
    </div>
  );
}

const ago = (iso: string | null) => {
  if (!iso) return 'never seen';
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 120) return 'seen just now';
  if (s < 3600) return `seen ${Math.round(s / 60)}m ago`;
  if (s < 86400) return `seen ${Math.round(s / 3600)}h ago`;
  return `seen ${Math.round(s / 86400)}d ago`;
};

export function InfraHealthGrid({ items, compact }: { items: InfraItem[]; compact?: boolean }) {
  const nav = useNavigate();
  const counts = items.reduce<Record<string, number>>((m, s) => { const k = infraStatus(s); m[k] = (m[k] ?? 0) + 1; return m; }, {});
  return (
    <div className="infra">
      <div className="infra-summary">
        {(['CRITICAL', 'WARNING', 'HEALTHY', 'UNKNOWN'] as const).filter((k) => counts[k]).map((k) => {
          const M = META[k];
          return <span key={k} className={`status-chip ${M.cls}`}><M.icon size={12} />{counts[k]} {M.label.toLowerCase()}</span>;
        })}
      </div>
      <div className={`infra-grid ${compact ? 'compact' : ''}`}>
        {items.map((s) => {
          const k = infraStatus(s);
          const M = META[k];
          return (
            <button key={s.serverId} className={`infra-tile ${M.cls}`} onClick={() => nav(`/infrastructure?server=${s.serverId}`)} title={`${s.name} — ${M.label} (${ago(s.lastSeenAt)})`}>
              <div className="infra-top">
                <Server size={13} className="muted" />
                <span className="infra-name">{s.name}</span>
                <span className={`status-chip ${M.cls}`}><M.icon size={11} />{M.label}</span>
              </div>
              <div className="infra-sub">{[s.role, s.environmentName].filter(Boolean).join(' · ') || '—'} · {ago(s.lastSeenAt)}</div>
              <Meter label="CPU" v={s.cpuPct} />
              <Meter label="MEM" v={s.memoryPct} />
            </button>
          );
        })}
      </div>
    </div>
  );
}
