import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DatabaseZap } from 'lucide-react';
import { api } from '@/services/api';
import { Field, Modal } from '@/components/ui';
import type { RunDetail } from './types';

interface Integration { id: string; name: string; type: string; status: string; health?: string | null; config?: Record<string, any> }
interface ImportResult { runId: string; points: number; events: number; transactions: number; from: string; to: string; status: string }

/** datetime-local value (local time, minute precision) ⇄ ISO */
const toLocal = (v: string | number | Date | null | undefined) => {
  if (!v) return '';
  const d = new Date(v);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
};
const fromLocal = (v: string) => (v ? new Date(v).toISOString() : undefined);

/**
 * Pulls JMeter Backend Listener results that were written to the team's own InfluxDB
 * into this run (POST /runs/{runId}/import/influx-jmeter).
 */
export function InfluxImportDialog({ run, open, onClose, onNotice }: { run: RunDetail; open: boolean; onClose: () => void; onNotice: (msg: string, kind?: 'ok' | 'err') => void }) {
  const qc = useQueryClient();
  const ints = useQuery({
    queryKey: ['integrations', 'INFLUXDB'], enabled: open,
    queryFn: async () => {
      const r = await api.get<Integration[] | { items: Integration[] }>('/integrations');
      return (Array.isArray(r) ? r : r.items).filter((i) => i.type === 'INFLUXDB' && i.status !== 'DISABLED');
    },
  });
  const [integrationId, setIntegrationId] = useState('');
  const [measurement, setMeasurement] = useState('jmeter');
  const [application, setApplication] = useState('');
  const [from, setFrom] = useState(() => toLocal(run.startedAt ? new Date(run.startedAt).getTime() - 60_000 : null));
  const [to, setTo] = useState(() => toLocal(run.endedAt ? new Date(run.endedAt).getTime() + 60_000 : null));
  const unfinished = ['SCHEDULED', 'QUEUED', 'RUNNING'].includes(run.status);
  const [complete, setComplete] = useState(unfinished);
  const chosen = integrationId || ints.data?.[0]?.id || '';

  const imp = useMutation({
    mutationFn: () => api.post<ImportResult>(`/runs/${run.runId}/import/influx-jmeter`, {
      integrationId: chosen, measurement: measurement.trim() || 'jmeter', application: application.trim() || null,
      from: fromLocal(from), to: fromLocal(to), complete: unfinished && complete,
    }),
    onSuccess: (r) => {
      onNotice(`Imported ${r.points.toLocaleString()} points (${r.transactions} transactions) from InfluxDB — analysis queued`);
      qc.invalidateQueries({ queryKey: ['run', run.runId] });
      qc.invalidateQueries({ queryKey: ['run-sub', run.runId] });
      onClose();
    },
  });

  const noWindow = !run.startedAt && (!from || !to);
  return (
    <Modal open={open} onClose={onClose} width={560} title={<span className="row" style={{ gap: 8 }}><DatabaseZap size={16} />Import JMeter results from InfluxDB</span>}
      footer={<>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={!chosen || noWindow || imp.isPending} onClick={() => imp.mutate()}>{imp.isPending ? 'Importing…' : 'Import'}</button>
      </>}>
      <div className="stack" style={{ gap: 12 }}>
        <p className="muted" style={{ margin: 0 }}>
          For tests whose Backend Listener writes to your own InfluxDB. Perfmon reads the JMeter measurement for the time window and stores it in
          <b className="mono"> {run.runId}</b> exactly like live listener data — transactions, percentiles (≈), errors, threads and start/end annotations.
          Importing again replaces the previously imported data.
        </p>
        {ints.isLoading ? <div className="skeleton" style={{ height: 36 }} /> : ints.data?.length ? (
          <Field label="InfluxDB integration">
            <select className="input" value={chosen} onChange={(e) => setIntegrationId(e.target.value)}>
              {ints.data.map((i) => <option key={i.id} value={i.id}>{i.name} · {String(i.config?.version ?? 'v2').toUpperCase()}{i.config?.database ? ` · db ${i.config.database}` : i.config?.bucket ? ` · bucket ${i.config.bucket}` : ''}{i.health === 'DOWN' ? ' (last check failed)' : ''}</option>)}
            </select>
          </Field>
        ) : (
          <div className="notice">No InfluxDB integration yet. Add one under <Link to="/integrations">Platform → Integrations</Link> (URL, version, database or org + bucket, credentials), then come back.</div>
        )}
        <div className="grid" style={{ gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <Field label="Measurement" hint="Backend Listener “measurement” parameter">
            <input className="input" value={measurement} onChange={(e) => setMeasurement(e.target.value)} placeholder="jmeter" />
          </Field>
          <Field label="Application tag (optional)" hint="Backend Listener “application” parameter">
            <input className="input" value={application} onChange={(e) => setApplication(e.target.value)} placeholder="all applications" />
          </Field>
          <Field label="From">
            <input className="input" type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} />
          </Field>
          <Field label="To">
            <input className="input" type="datetime-local" value={to} onChange={(e) => setTo(e.target.value)} />
          </Field>
        </div>
        {noWindow && <div className="muted small">This run has not started, so give the test’s time window.</div>}
        {unfinished && (
          <label className="row" style={{ gap: 8 }}>
            <input type="checkbox" checked={complete} onChange={(e) => setComplete(e.target.checked)} />
            Complete the run after importing (runs the analysis: summary, SLA, regression, insights, score)
          </label>
        )}
        {imp.error && <div className="error-box" role="alert">{(imp.error as Error).message}</div>}
      </div>
    </Modal>
  );
}
