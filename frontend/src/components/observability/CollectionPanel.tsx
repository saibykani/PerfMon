import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Save } from 'lucide-react';
import { api } from '@/services/api';
import { Loading } from '@/components/ui';
import { HealthChip, friendlyError, toast, useCan } from '@/components/inventory/common';
import { useEnvironments } from '@/components/inventory/data';
import { itemsOf } from '@/components/platform/kit';
import { useObsFilters } from '@/stores/obsFilters';
import type { CollectionSchedule } from './obsApi';
import { formatTs } from './obsTime';

interface Integration { id: string; name: string; type: string; status: string; projectName?: string | null }
const COLLECTABLE = /influx|prometheus|dynatrace|kubernetes|k8s/i;
const INTERVALS = [60, 120, 300, 600, 900, 1800, 3600];
const iv = (s: number) => (s >= 3600 ? `${s / 3600}h` : `${s / 60} min`);

/** Continuous (run-independent) metric collection per integration — GET/POST /observability/collection. */
export function CollectionPanel() {
  const can = useCan();
  const manage = can('MANAGE_INTEGRATIONS');
  const tz = useObsFilters((s) => s.tz);
  const ints = useQuery({ queryKey: ['integrations', 'obs-collection'], queryFn: async () => itemsOf<Integration>(await api.get('/integrations')) });
  const sched = useQuery({ queryKey: ['obs', 'collection'], queryFn: async () => itemsOf<CollectionSchedule>(await api.get('/observability/collection')), refetchInterval: 30_000 });
  const envs = useEnvironments({});
  const rows = useMemo(() => {
    const byId = new Map((sched.data ?? []).map((s) => [s.integrationId, s]));
    const list = (ints.data ?? []).filter((i) => COLLECTABLE.test(i.type) || byId.has(i.id));
    // schedules for integrations not in the list (other project scope) still show
    for (const s of sched.data ?? []) if (!list.some((i) => i.id === s.integrationId)) list.push({ id: s.integrationId, name: s.integrationName ?? s.name ?? s.integrationId, type: s.type ?? '—', status: 'ENABLED' });
    return list.map((i) => ({ i, s: byId.get(i.id) }));
  }, [ints.data, sched.data]);

  if (ints.isLoading || sched.isLoading) return <Loading height={160} />;
  return (
    <div className="stack">
      <div className="muted small">Imports metrics from InfluxDB, Prometheus and Dynatrace mappings on a timer, independent of test runs, so the Explorer has data for any time window. Kubernetes connections sample continuously instead of only while the module is open.</div>
      {sched.error && <div className="obs-err small">Schedules unavailable: {friendlyError(sched.error)}</div>}
      {!rows.length && <div className="empty">No InfluxDB, Prometheus, Dynatrace or Kubernetes integrations. Add one under Platform → Integrations.</div>}
      {rows.map(({ i, s }) => <CollectionRow key={i.id} i={i} s={s} manage={manage} tz={tz} envs={(envs.data ?? []).map((e) => ({ id: e.id, name: `${e.name} · ${e.application_name ?? ''}` }))} />)}
    </div>
  );
}

function CollectionRow({ i, s, manage, tz, envs }: { i: Integration; s?: CollectionSchedule; manage: boolean; tz: 'local' | 'utc'; envs: { id: string; name: string }[] }) {
  const qc = useQueryClient();
  const [enabled, setEnabled] = useState(!!s?.enabled);
  const [interval, setInterval_] = useState(s?.intervalSec ?? 300);
  const [env, setEnv] = useState(s?.environmentId ?? '');
  useEffect(() => { setEnabled(!!s?.enabled); setInterval_(s?.intervalSec ?? 300); setEnv(s?.environmentId ?? ''); }, [s?.enabled, s?.intervalSec, s?.environmentId]);
  const dirty = enabled !== !!s?.enabled || interval !== (s?.intervalSec ?? 300) || env !== (s?.environmentId ?? '');
  const save = useMutation({
    mutationFn: () => api.post('/observability/collection', { integrationId: i.id, enabled, intervalSec: Math.max(60, interval), environmentId: env || null }),
    onSuccess: () => { toast.success(`${i.name}: collection ${enabled ? `every ${iv(interval)}` : 'disabled'}`); qc.invalidateQueries({ queryKey: ['obs', 'collection'] }); },
    onError: (e) => toast.error(friendlyError(e)),
  });
  const status = s?.lastStatus?.toUpperCase();
  return (
    <div className="obs-coll-row">
      <div className="obs-coll-head">
        <div style={{ minWidth: 0 }}><b>{i.name}</b> <span className="badge">{i.type}</span>{i.status !== 'ENABLED' && <span className="badge warn" style={{ marginLeft: 4 }}>integration disabled</span>}</div>
        <label className="row small" style={{ gap: 6 }}><input type="checkbox" checked={enabled} disabled={!manage} onChange={(e) => setEnabled(e.target.checked)} aria-label={`Collect ${i.name} continuously`} />Continuous</label>
      </div>
      <div className="obs-coll-grid">
        <label className="field"><span className="small muted">Interval</span>
          <select className="select" value={interval} disabled={!manage} onChange={(e) => setInterval_(Number(e.target.value))}>
            {[...new Set([...INTERVALS, interval])].sort((a, b) => a - b).map((x) => <option key={x} value={x}>{iv(x)}</option>)}
          </select></label>
        <label className="field"><span className="small muted">Environment link</span>
          <select className="select" value={env} disabled={!manage} onChange={(e) => setEnv(e.target.value)}>
            <option value="">None</option>{envs.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
          </select></label>
      </div>
      <div className="obs-coll-status small">
        {s?.lastRunAt ? <>
          <HealthChip status={status === 'OK' || status === 'SUCCESS' ? 'HEALTHY' : status === 'ERROR' || status === 'FAILED' ? 'CRITICAL' : status === 'NO_DATA' ? 'WARNING' : status ?? null} compact />
          <span>Last run <span className="mono">{formatTs(+new Date(s.lastRunAt), tz)}</span></span>
          {s.points != null && <span>· {s.points.toLocaleString()} points</span>}
        </> : <span className="muted">{s ? 'Not run yet' : 'Not scheduled'}</span>}
        {s?.lastError && <div className="obs-err">{s.lastError}</div>}
      </div>
      {manage && <div><button className="btn btn-sm btn-primary" disabled={!dirty || save.isPending} onClick={() => save.mutate()}><Save size={13} />{save.isPending ? 'Saving…' : 'Save'}</button></div>}
    </div>
  );
}
