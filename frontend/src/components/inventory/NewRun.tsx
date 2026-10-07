import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { Activity, CheckCircle2, Flag, Play, Radio, Terminal } from 'lucide-react';
import { api, API_BASE } from '@/services/api';
import { Modal, Tabs } from '@/components/ui';
import { StatusBadge } from '@/components/Status';
import { CodeBlock, CopyButton, FormField, Notice, fieldErrors, friendlyError, toast } from './common';
import { useInvalidateInventory, type TestRow } from './data';

interface CreatedRun { id: string; runId: string; status: string; ingest: { metrics: string; jmeterInfluxListenerUrl: string; artifacts: string; complete: string } }

/** Base URL that JMeter / CI should reach (explicit API origin when the UI is hosted separately). */
export const perfmonOrigin = () => API_BASE || window.location.origin;

/**
 * "New run" flow: POST /runs → shows the generated Run ID and ready-to-paste JMeter
 * Backend Listener settings, curl and CLI examples; then start/complete and jump to Live.
 */
export function NewRunDialog({ open, onClose, test }: { open: boolean; onClose: () => void; test: Pick<TestRow, 'id' | 'name' | 'application_name' | 'environment_name' | 'virtual_users'> | null }) {
  const inv = useInvalidateInventory();
  const blank = { buildNumber: '', version: '', branch: '', commit: '', releaseVersion: '', tags: '', description: '' };
  const [v, setV] = useState(blank);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [run, setRun] = useState<CreatedRun | null>(null);
  const [status, setStatus] = useState<string>('QUEUED');
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<'jmeter' | 'cli' | 'api'>('jmeter');
  useEffect(() => { if (open) { setV(blank); setErrors({}); setFormError(null); setRun(null); setStatus('QUEUED'); setTab('jmeter'); } }, [open, test?.id]); // eslint-disable-line
  const bind = (k: keyof typeof blank) => ({ id: `nr-${k}`, value: v[k], onChange: (e: { target: { value: string } }) => setV((o) => ({ ...o, [k]: e.target.value })) });

  const create = async (e: FormEvent) => {
    e.preventDefault();
    if (!test) return;
    setSaving(true); setFormError(null); setErrors({});
    try {
      const body: Record<string, unknown> = { testId: test.id, status: 'QUEUED', triggeredBy: 'MANUAL' };
      for (const k of ['buildNumber', 'version', 'branch', 'commit', 'releaseVersion', 'description'] as const) if (v[k].trim()) body[k] = v[k].trim();
      const tags = v.tags.split(',').map((t) => t.trim()).filter(Boolean);
      if (tags.length) body.tags = tags;
      const res = await api.post<CreatedRun>('/runs', body);
      setRun(res); setStatus(res.status);
      inv();
      toast.success(<>Run <b className="mono">{res.runId}</b> created</>);
    } catch (x) { setErrors(fieldErrors(x)); setFormError(friendlyError(x)); } finally { setSaving(false); }
  };
  const action = async (kind: 'start' | 'complete') => {
    if (!run) return;
    setBusy(true);
    try {
      const r = await api.post<{ status: string }>(`/runs/${run.runId}/${kind}`, {});
      setStatus(r.status);
      inv();
      toast.success(kind === 'start' ? `${run.runId} marked as running` : `${run.runId} completed — analysis queued`);
    } catch (x) { toast.error(friendlyError(x)); } finally { setBusy(false); }
  };

  const origin = perfmonOrigin();
  const listenerUrl = run ? `${origin}/api/v1/ingest/influx/write?runId=${run.runId}` : '';
  const settings: [string, string][] = run ? [
    ['influxdbMetricsSender', 'org.apache.jmeter.visualizers.backend.influxdb.HttpMetricsSender'],
    ['influxdbUrl', listenerUrl],
    ['influxdbToken', '<PERFMON_API_KEY>'],
    ['application', test?.application_name ?? 'app'],
    ['measurement', 'jmeter'],
    ['summaryOnly', 'false'],
    ['samplersRegex', '.*'],
    ['percentiles', '50;90;95;99'],
    ['testTitle', run.runId],
    ['eventTags', `runId=${run.runId}`],
  ] : [];
  const curl = run ? `# Push samples (JSON API) — use an API key with the "ingest" scope
curl -X POST "${origin}/api/v1/runs/${run.runId}/metrics" \\
  -H "Authorization: Bearer $PERFMON_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"samples":[{"ts":${Date.now()},"label":"GET /health","elapsed":42,"success":true,"responseCode":"200","allThreads":1}]}'

# Upload the JTL / HTML report when the test ends
curl -X POST "${origin}/api/v1/runs/${run.runId}/artifacts" \\
  -H "Authorization: Bearer $PERFMON_API_KEY" -F "file=@results.jtl" -F "kind=JTL"

# Complete the run (starts SLA, regression and insight analysis)
curl -X POST "${origin}/api/v1/runs/${run.runId}/complete" -H "Authorization: Bearer $PERFMON_API_KEY"` : '';
  const cli = run ? `jmeter -n -t ${(test?.name ?? 'test').replace(/[^a-z0-9]+/gi, '_').toLowerCase()}.jmx \\
  -Jperfmon.runId=${run.runId} \\
  -Jperfmon.url=${origin} \\
  -Jperfmon.token=$PERFMON_API_KEY \\
  -l results.jtl -e -o report/

# In the Backend Listener reference the properties:
#   influxdbUrl   = \${__P(perfmon.url)}/api/v1/ingest/influx/write?runId=\${__P(perfmon.runId)}
#   influxdbToken = \${__P(perfmon.token)}` : '';

  return (
    <Modal open={open} onClose={onClose} width={run ? 760 : 560}
      title={run ? <span className="row"><CheckCircle2 size={16} className="inv-ok" />Run created — configure JMeter</span> : <span className="row"><Play size={15} />New run · {test?.name}</span>}
      footer={run ? (
        <>
          <span className="row muted" style={{ marginRight: 'auto' }}>Status <StatusBadge value={status} /></span>
          {(status === 'QUEUED' || status === 'SCHEDULED') && <button className="btn" disabled={busy} onClick={() => action('start')}><Radio size={14} />Mark running</button>}
          {(status === 'QUEUED' || status === 'RUNNING' || status === 'SCHEDULED') && <button className="btn" disabled={busy} onClick={() => action('complete')}><Flag size={14} />Complete run</button>}
          <Link className="btn btn-primary" to={`/live/${run.runId}`}><Activity size={14} />Open Live Monitoring</Link>
        </>
      ) : (
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" type="submit" form="new-run-form" disabled={saving || !test}>{saving ? 'Generating…' : 'Generate Run ID'}</button>
        </>
      )}>
      {!run ? (
        <form id="new-run-form" onSubmit={create} noValidate>
          {formError && <div className="error-box" role="alert" style={{ marginBottom: 12 }}>{formError}</div>}
          <div className="muted" style={{ marginBottom: 12 }}>{test?.application_name} · {test?.environment_name}{test?.virtual_users ? ` · ${test.virtual_users} VUs` : ''}. All fields are optional — they make runs searchable and comparable.</div>
          <div className="inv-form-grid">
            <FormField label="Build number" error={errors.buildNumber} htmlFor="nr-buildNumber"><input className="input mono" {...bind('buildNumber')} placeholder="1287" /></FormField>
            <FormField label="Version" error={errors.version} htmlFor="nr-version"><input className="input mono" {...bind('version')} placeholder="2.14.0" /></FormField>
            <FormField label="Branch" error={errors.branch} htmlFor="nr-branch"><input className="input mono" {...bind('branch')} placeholder="main" /></FormField>
            <FormField label="Commit" error={errors.commit} htmlFor="nr-commit"><input className="input mono" {...bind('commit')} placeholder="a1b2c3d" /></FormField>
            <FormField label="Release version" error={errors.releaseVersion} htmlFor="nr-releaseVersion" hint="Links (or creates) the release"><input className="input mono" {...bind('releaseVersion')} placeholder="2026.10.1" /></FormField>
            <FormField label="Tags" error={errors.tags} htmlFor="nr-tags" hint="Comma separated"><input className="input" {...bind('tags')} placeholder="nightly, pre-release" /></FormField>
            <FormField label="Description" error={errors.description} htmlFor="nr-description" span={2}><textarea className="textarea" rows={2} {...bind('description')} /></FormField>
          </div>
        </form>
      ) : (
        <div className="stack">
          <div className="inv-runid">
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="inv-runid-label">Run ID</div>
              <div className="inv-runid-value" data-testid="run-id">{run.runId}</div>
              <div className="muted" style={{ fontSize: 12 }}>Every metric, artifact and report for this execution references this ID.</div>
            </div>
            <CopyButton text={run.runId} label="Copy Run ID" className="btn-primary" />
          </div>
          <Tabs value={tab} onChange={setTab} tabs={[{ key: 'jmeter', label: 'JMeter Backend Listener' }, { key: 'cli', label: 'JMeter CLI' }, { key: 'api', label: 'curl / JSON API' }]} />
          {tab === 'jmeter' && (
            <>
              <div className="muted">Add <b>Backend Listener</b> → implementation <span className="mono">org.apache.jmeter.visualizers.backend.influxdb.InfluxdbBackendListenerClient</span> and set:</div>
              <div className="card" style={{ overflow: 'hidden' }}>
                <table className="inv-settings"><tbody>
                  {settings.map(([k, val]) => <tr key={k}><td>{k}</td><td>{val}</td><td><CopyButton text={val} /></td></tr>)}
                </tbody></table>
              </div>
              <div className="row wrap">
                <CopyButton text={settings.map(([k, val]) => `${k}=${val}`).join('\n')} label="Copy all settings" />
                <span className="muted" style={{ fontSize: 12 }}>Replace <span className="mono">&lt;PERFMON_API_KEY&gt;</span> with an API key that has the <b>ingest</b> scope (Admin → API keys).</span>
              </div>
            </>
          )}
          {tab === 'cli' && <CodeBlock label="Non-GUI execution" code={cli} />}
          {tab === 'api' && <CodeBlock label="JSON ingestion API" code={curl} />}
          <Notice><span>The run is <b>{status}</b>. It switches to RUNNING when the first metrics arrive (or mark it manually). <Terminal size={12} style={{ verticalAlign: -2 }} /> When the load test ends, click <b>Complete run</b> or call the complete endpoint from CI.</span></Notice>
        </div>
      )}
    </Modal>
  );
}
