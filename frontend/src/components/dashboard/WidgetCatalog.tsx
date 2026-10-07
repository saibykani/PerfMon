import { useMemo, useState } from 'react';
import {
  Activity, AlertTriangle, AreaChart, BarChart2, BarChart3, BarChartBig, Crosshair, FileText, Flame, Gauge, Grid3x3, Hash, LineChart,
  ListOrdered, PieChart, ScatterChart, Search, ShieldCheck, Table2, Users, Zap, type LucideIcon,
} from 'lucide-react';
import { Modal } from '@/components/ui';
import { WIDGETS, type Widget, type WidgetGroup } from './catalog';

export const ICONS: Record<string, LucideIcon> = {
  Activity, AlertTriangle, AreaChart, BarChart2, BarChart3, BarChartBig, Crosshair, FileText, Flame, Gauge, Grid3x3, Hash, LineChart, ListOrdered, PieChart, ScatterChart, ShieldCheck, Table2, Users, Zap,
};

const GROUPS: { key: WidgetGroup; label: string; hint: string }[] = [
  { key: 'KPI', label: 'KPIs', hint: 'Single numbers for the selected run' },
  { key: 'Performance', label: 'Performance', hint: 'Purpose-built load-test visualisations' },
  { key: 'Charts', label: 'Charts', hint: 'General visualisations over any metric' },
  { key: 'Content', label: 'Content', hint: 'Text and notes' },
];

export function WidgetCatalog({ open, onClose, onPick }: { open: boolean; onClose: () => void; onPick: (w: Widget) => void }) {
  const [q, setQ] = useState('');
  const [group, setGroup] = useState<WidgetGroup | 'all'>('all');
  const list = useMemo(() => WIDGETS.filter((w) => (group === 'all' || w.group === group) && (!q || `${w.label} ${w.description}`.toLowerCase().includes(q.toLowerCase()))), [q, group]);
  return (
    <Modal open={open} onClose={onClose} title="Add panel" width={880}>
      <div className="catalog">
        <div className="catalog-top">
          <div className="dt-search" style={{ flex: 1 }}>
            <Search size={13} />
            <input className="input" style={{ width: '100%' }} placeholder="Search widgets — e.g. P95, heatmap, ranking…" value={q} onChange={(e) => setQ(e.target.value)} autoFocus aria-label="Search widgets" />
          </div>
          <div className="seg">
            <button className={group === 'all' ? 'on' : ''} onClick={() => setGroup('all')}>All</button>
            {GROUPS.map((g) => <button key={g.key} className={group === g.key ? 'on' : ''} onClick={() => setGroup(g.key)}>{g.label}</button>)}
          </div>
        </div>
        {GROUPS.filter((g) => list.some((w) => w.group === g.key)).map((g) => (
          <section key={g.key}>
            <div className="catalog-group"><b>{g.label}</b><span className="muted">{g.hint}</span></div>
            <div className="catalog-grid">
              {list.filter((w) => w.group === g.key).map((w) => {
                const Icon = ICONS[w.icon] ?? BarChart3;
                return (
                  <button key={w.id} className="catalog-item" onClick={() => onPick(w)} data-widget={w.id}>
                    <span className={`catalog-icon g-${g.key.toLowerCase()}`}><Icon size={16} /></span>
                    <span className="catalog-text"><b>{w.label}</b><span>{w.description}</span></span>
                  </button>
                );
              })}
            </div>
          </section>
        ))}
        {!list.length && <div className="empty">No widget matches “{q}”.</div>}
      </div>
    </Modal>
  );
}
