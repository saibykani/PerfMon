import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { EChartsOption } from 'echarts';
import { ArrowUpRight, Copy, Gauge, Info, Plus, Save, ShieldCheck, Target, Trash2, Undo2 } from 'lucide-react';
import { api } from '@/services/api';
import { useAuth } from '@/stores/auth';
import { useFilters, resolveRange } from '@/stores/filters';
import { useUi } from '@/stores/ui';
import { PageHeader, Card, Kpi, ConfirmDialog } from '@/components/ui';
import { DataTable, type Column } from '@/components/DataTable';
import { TimeRangePicker } from '@/components/GlobalFilters';
import { fmtDate, fmtNum, fmtPct } from '@/components/format';
import { Chart } from '@/charts/Chart';
import { gaugeOption } from '@/charts/builders';
import { seriesColor } from '@/charts/palette';
import {
  camel, camelAll, Chip, EmptyState, errMsg, FormField, PermissionNote, ProjectPicker, Seg, SkeletonRows, toast, ToastHost, Toggle,
  Unavailable, useProjectScope, plural,
} from '@/components/platform/kit';
import {
  BandPreview, blankRule, METRIC_GROUPS, ruleFromRow, ruleSentence, ruleToBody, SHORT, TXN_METRICS, validateRule, unitSuffix,
  type RuleDraft, type SlaMetrics,
} from '@/components/platform/sla';

interface Profile { id: string; projectId: string; name: string; description: string | null; testCount: number; rules: any[]; updatedAt?: string }
interface Summary {
  compliance: number | null;
  runs: { runKey: string; testName: string; startedAt: string; passPct: number | null; violations: number }[];
  topViolations: { metric: string; transaction: string | null; count: number; runKey?: string; lastRunKey?: string }[];
}

interface Draft { id: string | null; projectId: string; name: string; description: string; rules: RuleDraft[] }

const toDraft = (p: Profile): Draft => ({ id: p.id, projectId: p.projectId, name: p.name, description: p.description ?? '', rules: p.rules.map(ruleFromRow) });
const sig = (d: Draft | null) => (d ? JSON.stringify({ n: d.name.trim(), d: d.description.trim(), r: d.rules.map((r) => ({ ...ruleToBody(r) })) }) : '');

export function SlaPage() {
  const can = useAuth((s) => s.can);
  const editable = can('CONFIGURE_SLA');
  const { projectId, writeProjectId, projects } = useProjectScope();
  const qc = useQueryClient();

  const metricsQ = useQuery({ queryKey: ['sla-metrics'], queryFn: () => api.get<SlaMetrics>('/sla/metrics'), staleTime: Infinity });
  const metrics = metricsQ.data ?? {};
  const profilesQ = useQuery({
    queryKey: ['sla-profiles', projectId],
    queryFn: async () => camelAll<Profile>(await api.get<any[]>('/sla/profiles', { projectId })).map((p) => ({ ...p, rules: p.rules ?? [] })),
  });
  const profiles = profilesQ.data ?? [];

  const [selected, setSelected] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [base, setBase] = useState('');
  const [pendingSelect, setPendingSelect] = useState<string | null | 'new'>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [showErrors, setShowErrors] = useState(false);

  const dirty = draft != null && sig(draft) !== base;

  const open = (id: string | 'new' | null) => {
    setShowErrors(false);
    if (id === 'new') {
      const d: Draft = { id: null, projectId: writeProjectId ?? '', name: '', description: '', rules: Object.keys(metrics).length ? [blankRule(metrics, 'p95'), { ...blankRule(metrics, 'error_pct'), warningValue: '1', criticalValue: '5' }] : [] };
      setSelected(null); setDraft(d); setBase(sig({ ...d, name: '\u0000' }));
      return;
    }
    const p = profiles.find((x) => x.id === id);
    setSelected(id);
    if (p) { const d = toDraft(p); setDraft(d); setBase(sig(d)); } else { setDraft(null); setBase(''); }
  };
  const requestOpen = (id: string | 'new' | null) => { if (dirty) setPendingSelect(id); else open(id); };

  // keep the first profile selected once loaded
  useEffect(() => {
    if (!profilesQ.data) return;
    if (draft?.id == null && draft) return; // creating a new one
    if (selected && profiles.some((p) => p.id === selected)) return;
    open(profiles[0]?.id ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profilesQ.data]);

  const ruleErrors = useMemo(() => (draft ? draft.rules.map(validateRule) : []), [draft]);
  const nameError = draft && !draft.name.trim() ? 'Profile name is required' : draft && draft.name.length > 120 ? 'Max 120 characters' : null;
  const projectError = draft && draft.id == null && !draft.projectId ? 'Choose a project' : null;
  const invalid = !!nameError || !!projectError || ruleErrors.some((e) => Object.keys(e).length > 0);

  const save = useMutation({
    mutationFn: async (d: Draft) => {
      const body = { name: d.name.trim(), description: d.description.trim() || null, rules: d.rules.map(ruleToBody) };
      return camel<Profile>(d.id ? await api.put(`/sla/profiles/${d.id}`, body) : await api.post('/sla/profiles', { ...body, projectId: d.projectId }));
    },
    onSuccess: async (p) => {
      toast.success(<>SLA profile <b>{p.name}</b> saved{draft?.id ? ' — change recorded in the audit log' : ''}.</>);
      await qc.invalidateQueries({ queryKey: ['sla-profiles'] });
      const d = toDraft({ ...p, testCount: p.testCount ?? 0, rules: p.rules ?? [] });
      setSelected(p.id); setDraft(d); setBase(sig(d)); setShowErrors(false);
    },
    onError: (e) => toast.error(`Save failed: ${errMsg(e)}`),
  });
  const del = useMutation({
    mutationFn: (id: string) => api.del(`/sla/profiles/${id}`),
    onSuccess: async () => { toast.success('SLA profile deleted.'); setSelected(null); setDraft(null); await qc.invalidateQueries({ queryKey: ['sla-profiles'] }); },
    onError: (e) => toast.error(`Delete failed: ${errMsg(e)}`),
  });

  const onSave = () => {
    if (!draft) return;
    if (invalid) { setShowErrors(true); toast.error('Fix the highlighted fields before saving.'); return; }
    save.mutate(draft);
  };

  const patchRule = (key: string, patch: Partial<RuleDraft>) => setDraft((d) => d && { ...d, rules: d.rules.map((r) => (r.key === key ? { ...r, ...patch } : r)) });
  const current = profiles.find((p) => p.id === selected) ?? null;

  return (
    <div>
      <ToastHost />
      <PageHeader title="SLA & SLO" subtitle="Service-level objectives evaluated against every run — per run and per transaction, with warning and critical thresholds."
        actions={<><ProjectPicker /><TimeRangePicker /></>} />

      <ComplianceOverview projectId={projectId} />

      <div className="pf-section-title" style={{ marginTop: 16 }}>SLA profiles</div>
      {!editable && <PermissionNote perm="CONFIGURE_SLA" />}
      {metricsQ.error && <Unavailable what="SLA metric catalog" error={metricsQ.error} />}

      <div className="pf-split">
        <Card title={`Profiles${profiles.length ? ` · ${profiles.length}` : ''}`} noPad
          actions={editable && <button className="btn btn-sm btn-primary" onClick={() => requestOpen('new')} disabled={!projects.length}><Plus size={13} />New</button>}>
          {profilesQ.isLoading ? <div className="card-body"><SkeletonRows rows={4} height={44} /></div>
            : profilesQ.error ? <div className="card-body"><Unavailable what="SLA profiles" error={profilesQ.error} /></div>
              : !profiles.length && !(draft && draft.id == null) ? (
                <EmptyState icon={<Target size={20} />} title="No SLA profiles yet"
                  action={editable && <button className="btn btn-primary btn-sm" onClick={() => open('new')} disabled={!projects.length}><Plus size={13} />Create profile</button>}>
                  Profiles group SLA rules (e.g. “P95 &lt; 1 s”, “Error % &lt; 1%”). Assign a profile to a test and every run is evaluated automatically.
                </EmptyState>
              ) : (
                <div className="pf-list" role="listbox" aria-label="SLA profiles">
                  {draft && draft.id == null && (
                    <button className="pf-list-item active" role="option" aria-selected>
                      <div className="t"><span className="name">{draft.name.trim() || 'Untitled profile'}</span><Chip tone="accent" icon={false}>New</Chip></div>
                      <div className="s"><span>{plural(draft.rules.length, 'rule')}</span><span>unsaved</span></div>
                    </button>
                  )}
                  {profiles.map((p) => {
                    const enabled = p.rules.filter((r: any) => r.enabled !== false).length;
                    return (
                      <button key={p.id} role="option" aria-selected={selected === p.id && draft?.id === p.id} className={`pf-list-item ${selected === p.id && draft?.id === p.id ? 'active' : ''}`} onClick={() => requestOpen(p.id)}>
                        <div className="t"><span className="name">{p.name}</span>{selected === p.id && dirty && <Chip tone="warn" icon={false}>Edited</Chip>}</div>
                        <div className="s">
                          <span>{plural(p.rules.length, 'rule')}{enabled !== p.rules.length ? ` (${enabled} on)` : ''}</span>
                          <span title="Tests using this profile">{plural(p.testCount ?? 0, 'test')}</span>
                          {!projectId && <span>{projects.find((x) => x.id === p.projectId)?.name}</span>}
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
        </Card>

        {draft ? (
          <Card title={draft.id ? 'Edit profile' : 'New profile'} actions={editable && <>
            {dirty && <span className="muted" style={{ fontSize: 12 }}>Unsaved changes</span>}
            {dirty && <button className="btn btn-sm" onClick={() => (draft.id ? open(draft.id) : open(profiles[0]?.id ?? null))}><Undo2 size={13} />Discard</button>}
            {draft.id && <button className="btn btn-sm btn-danger" onClick={() => setConfirmDelete(true)}><Trash2 size={13} />Delete</button>}
            <button className="btn btn-sm btn-primary" onClick={onSave} disabled={save.isPending || (!dirty && !!draft.id)}><Save size={13} />{save.isPending ? 'Saving…' : 'Save'}</button>
          </>}>
            <fieldset disabled={!editable} style={{ border: 0, padding: 0, margin: 0 }} className="stack">
              <div className="pf-form-grid">
                <FormField label="Profile name" required error={showErrors ? nameError : null} htmlFor="sla-name">
                  <input id="sla-name" className="input" value={draft.name} maxLength={120} placeholder="e.g. Checkout API — production SLO" onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
                </FormField>
                {draft.id == null ? (
                  <FormField label="Project" required error={showErrors ? projectError : null}>
                    <select className="select" value={draft.projectId} onChange={(e) => setDraft({ ...draft, projectId: e.target.value })}>
                      <option value="">Select project…</option>
                      {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                    </select>
                  </FormField>
                ) : (
                  <FormField label="Used by" hint="Tests assigned to this profile are evaluated on every run.">
                    <div className="row" style={{ height: 30 }}><Chip tone={current?.testCount ? 'accent' : 'neutral'} icon={false}>{plural(current?.testCount ?? 0, 'test')}</Chip>
                      <span className="muted">{projects.find((x) => x.id === draft.projectId)?.name}</span></div>
                  </FormField>
                )}
                <FormField label="Description" className="span-2">
                  <textarea className="textarea" rows={2} maxLength={2000} value={draft.description} placeholder="What does this objective protect? Who owns it?" onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
                </FormField>
              </div>

              <div className="row">
                <div className="pf-section-title" style={{ margin: 0 }}>Rules · {draft.rules.length}</div>
                <div className="spacer" />
                {editable && <button type="button" className="btn btn-sm" onClick={() => setDraft({ ...draft, rules: [...draft.rules, blankRule(metrics, 'p95')] })} disabled={!Object.keys(metrics).length}><Plus size={13} />Add rule</button>}
              </div>
              {!draft.rules.length && <div className="notice">No rules — add at least one objective (e.g. P95 &lt; 1000 ms) so runs can be evaluated.</div>}
              {draft.rules.map((r, i) => (
                <RuleCard key={r.key} rule={r} index={i} metrics={metrics} errors={showErrors ? ruleErrors[i] : {}} editable={editable}
                  onChange={(p) => patchRule(r.key, p)}
                  onDuplicate={() => setDraft({ ...draft, rules: [...draft.rules.slice(0, i + 1), { ...r, key: `${r.key}c${Date.now()}` }, ...draft.rules.slice(i + 1)] })}
                  onRemove={() => setDraft({ ...draft, rules: draft.rules.filter((x) => x.key !== r.key) })} />
              ))}
              <div className="pf-callout"><Info size={14} /><div>
                A run <b>passes</b> a rule when the measured value stays on the good side of the <b>critical</b> threshold; values past the <b>warning</b> threshold
                are reported but still pass. Transaction rules apply to every transaction whose name matches the glob pattern (<span className="mono">*</span> = any characters).
                Saving replaces the profile’s rules and is recorded in the audit log.
              </div></div>
            </fieldset>
          </Card>
        ) : (
          <Card><EmptyState icon={<ShieldCheck size={20} />} title="Select a profile">Choose a profile on the left to review or edit its rules.</EmptyState></Card>
        )}
      </div>

      <ConfirmDialog open={confirmDelete} onClose={() => setConfirmDelete(false)} title="Delete SLA profile"
        message={<>Delete <b>{current?.name}</b> and its {plural(current?.rules.length ?? 0, 'rule')}?{(current?.testCount ?? 0) > 0 && <> It is assigned to <b>{plural(current!.testCount, 'test')}</b>; their future runs will no longer be SLA-evaluated.</>} Past SLA results are kept.</>}
        onConfirm={() => current && del.mutate(current.id)} />
      <ConfirmDialog open={pendingSelect !== null} onClose={() => setPendingSelect(null)} title="Discard unsaved changes?" confirmLabel="Discard" danger
        message="You have unsaved changes to this SLA profile. Discard them?" onConfirm={() => { const t = pendingSelect; setPendingSelect(null); open(t); }} />
    </div>
  );
}

/* ------------------------------------------------------------------ rule editor */

function RuleCard({ rule, index, metrics, errors, editable, onChange, onRemove, onDuplicate }: {
  rule: RuleDraft; index: number; metrics: SlaMetrics; errors: Record<string, string>; editable: boolean;
  onChange: (p: Partial<RuleDraft>) => void; onRemove: () => void; onDuplicate: () => void;
}) {
  const def = metrics[rule.metric];
  const hasErr = Object.keys(errors).length > 0;
  const suffix = unitSuffix(rule.unit).trim() || rule.unit;
  return (
    <div className={`pf-rule ${rule.enabled ? '' : 'disabled'} ${hasErr ? 'invalid' : ''}`}>
      <div className="pf-rule-head">
        <span className="muted num" style={{ fontSize: 11 }}>#{index + 1}</span>
        <span className="pf-rule-sentence">{ruleSentence(rule)}</span>
        {rule.criticalValue && rule.warningValue && <span className="muted" style={{ fontSize: 12 }}>warn at {rule.warningValue}{suffix === '/s' ? '/s' : ` ${suffix}`}</span>}
        <div className="spacer" />
        <Toggle checked={rule.enabled} onChange={(v) => onChange({ enabled: v })} label={rule.enabled ? 'Enabled' : 'Disabled'} disabled={!editable} />
        {editable && <button type="button" className="btn btn-ghost icon-btn btn-sm" title="Duplicate rule" aria-label="Duplicate rule" onClick={onDuplicate}><Copy size={13} /></button>}
        {editable && <button type="button" className="btn btn-ghost icon-btn btn-sm" title="Remove rule" aria-label="Remove rule" onClick={onRemove}><Trash2 size={13} /></button>}
      </div>
      <div className="pf-rule-body">
        <FormField label="Metric" error={errors.metric}>
          <select className="select" value={rule.metric} onChange={(e) => {
            const m = metrics[e.target.value];
            const scope = rule.scope === 'TRANSACTION' && !TXN_METRICS.has(e.target.value) ? 'RUN' : rule.scope;
            onChange({ metric: e.target.value, unit: m?.unit ?? rule.unit, direction: m?.direction ?? rule.direction, scope, ...(m && m.unit !== rule.unit ? { warningValue: '', criticalValue: '' } : {}) });
          }}>
            {METRIC_GROUPS.map((g) => (
              <optgroup key={g.label} label={g.label}>
                {g.keys.filter((k) => metrics[k]).map((k) => <option key={k} value={k}>{SHORT[k]} — {metrics[k].label}</option>)}
              </optgroup>
            ))}
            {Object.keys(metrics).filter((k) => !METRIC_GROUPS.some((g) => g.keys.includes(k))).map((k) => <option key={k} value={k}>{metrics[k].label}</option>)}
          </select>
        </FormField>
        <FormField label="Scope">
          <Seg ariaLabel="Scope" value={rule.scope} onChange={(v) => onChange({ scope: v })}
            options={[{ value: 'RUN', label: 'Run' }, ...(TXN_METRICS.has(rule.metric) ? [{ value: 'TRANSACTION' as const, label: 'Transaction' }] : [])]} />
        </FormField>
        {rule.scope === 'TRANSACTION' ? (
          <FormField label="Transaction pattern" error={errors.transactionPattern} hint="Glob, case-insensitive">
            <input className="input mono" value={rule.transactionPattern} placeholder="e.g. Checkout_* or *" onChange={(e) => onChange({ transactionPattern: e.target.value })} />
          </FormField>
        ) : (
          <FormField label="Direction" hint={def ? `Default for ${SHORT[rule.metric] ?? rule.metric}: ${def.direction === 'LOWER' ? 'lower' : 'higher'} is better` : undefined}>
            <select className="select" value={rule.direction} onChange={(e) => onChange({ direction: e.target.value as RuleDraft['direction'] })}>
              <option value="LOWER">Lower is better</option><option value="HIGHER">Higher is better</option>
            </select>
          </FormField>
        )}
        <FormField label="Unit"><input className="input" value={rule.unit} readOnly aria-readonly title="Unit is defined by the metric" /></FormField>
        <FormField label="Warning" error={errors.warningValue}>
          <div className="pf-input-unit"><input className="input num" inputMode="decimal" value={rule.warningValue} placeholder="—" onChange={(e) => onChange({ warningValue: e.target.value })} /><span className="pf-unit">{suffix}</span></div>
        </FormField>
        <FormField label="Critical" error={errors.criticalValue}>
          <div className="pf-input-unit"><input className="input num" inputMode="decimal" value={rule.criticalValue} placeholder="—" onChange={(e) => onChange({ criticalValue: e.target.value })} /><span className="pf-unit">{suffix}</span></div>
        </FormField>
      </div>
      <div className="pf-rule-foot">
        {rule.scope === 'TRANSACTION' && (
          <div className="row" style={{ marginBottom: 8 }}>
            <span className="pf-sub">Direction</span>
            <Seg ariaLabel="Direction" value={rule.direction} onChange={(v) => onChange({ direction: v })} options={[{ value: 'LOWER', label: 'Lower is better' }, { value: 'HIGHER', label: 'Higher is better' }]} />
            <div className="spacer" />
          </div>
        )}
        <BandPreview rule={rule} />
        <div className="row" style={{ marginTop: 8 }}>
          <input className="input" style={{ maxWidth: 360, height: 26, fontSize: 12 }} value={rule.name} maxLength={120} placeholder="Optional rule name (shown in reports)" aria-label="Rule name" onChange={(e) => onChange({ name: e.target.value })} />
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ compliance overview */

function ComplianceOverview({ projectId }: { projectId: string | null }) {
  const timeRange = useFilters((s) => s.timeRange);
  const theme = useUi((s) => s.theme);
  const range = resolveRange(timeRange);
  const q = useQuery({
    queryKey: ['sla-summary', projectId, timeRange],
    queryFn: () => api.get<Summary>('/sla/summary', { projectId, from: range?.from, to: range?.to }),
    retry: (n, e: any) => e?.status !== 404 && n < 2,
  });
  const data = q.data;
  const runs = useMemo(() => [...(data?.runs ?? [])].map(camel<Summary['runs'][number]>).sort((a, b) => new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime()), [data]);
  const evaluated = runs.filter((r) => r.passPct != null);
  const fullyPassing = evaluated.filter((r) => (r.passPct ?? 0) >= 100).length;
  const totalViolations = runs.reduce((a, r) => a + (r.violations ?? 0), 0);
  const top = (data?.topViolations ?? []).map(camel<Summary['topViolations'][number]>);

  const barOption = useMemo<EChartsOption>(() => ({
    grid: { top: 10, bottom: 4, left: 4, right: 10 },
    tooltip: { trigger: 'axis', valueFormatter: (v: any) => (v == null ? '—' : `${(+v).toFixed(1)}%`) },
    xAxis: { type: 'category', data: evaluated.map((r) => r.runKey), axisLabel: { formatter: (v: string) => v.slice(-6) } },
    yAxis: { type: 'value', min: 0, max: 100, axisLabel: { formatter: (v: number) => `${v}%` }, splitNumber: 4 },
    series: [{ type: 'bar', name: 'SLA pass %', data: evaluated.map((r) => (r.passPct == null ? null : +r.passPct.toFixed(2))), barMaxWidth: 18, itemStyle: { color: seriesColor(theme, 0), borderRadius: [3, 3, 0, 0] } }],
  }), [evaluated, theme]);

  if (q.isLoading) return <div className="pf-grid-3"><div className="skeleton" style={{ height: 210 }} /><div className="skeleton" style={{ height: 210 }} /><div className="skeleton" style={{ height: 210 }} /></div>;
  if (q.error) return <Unavailable what="SLA compliance summary (/sla/summary)" error={q.error} />;

  const comp = data?.compliance ?? null;
  const tone = comp == null ? undefined : comp >= 95 ? 'pass' : comp >= 80 ? 'warn' : 'fail';
  const runCols: Column<Summary['runs'][number]>[] = [
    { key: 'runKey', header: 'Run ID', render: (r) => <Link className="mono" to={`/runs/${r.runKey}/sla`}>{r.runKey}</Link> },
    { key: 'testName', header: 'Test' },
    { key: 'startedAt', header: 'Started', render: (r) => fmtDate(r.startedAt), value: (r) => new Date(r.startedAt).getTime() },
    { key: 'passPct', header: 'Pass %', align: 'right', render: (r) => <PassBar v={r.passPct} /> },
    { key: 'violations', header: 'Violations', align: 'right', render: (r) => (r.violations ? <Chip tone="fail">{r.violations}</Chip> : <Chip tone="pass">0</Chip>) },
    { key: 'go', header: '', sortable: false, render: (r) => <Link to={`/runs/${r.runKey}/sla`} className="btn btn-ghost btn-sm" aria-label={`Open SLA tab of ${r.runKey}`}>SLA <ArrowUpRight size={12} /></Link> },
  ];
  const latestViolating = [...runs].reverse().find((r) => r.violations > 0);

  return (
    <div className="stack">
      <div className="pf-grid-3" style={{ gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1.4fr) minmax(0, 1.2fr)' }}>
        <Card title="SLA compliance">
          <div className="row" style={{ alignItems: 'center', gap: 12 }}>
            <div style={{ width: 150, flex: 'none' }}>
              <Chart option={gaugeOption({ theme, value: comp, unit: '%' })} height={130} />
            </div>
            <div className="stack" style={{ gap: 6, minWidth: 0 }}>
              {tone && <Chip tone={tone}>{tone === 'pass' ? 'On target' : tone === 'warn' ? 'At risk' : 'Breaching'}</Chip>}
              <span className="pf-formula">SLA Compliance = Passed / Total × 100</span>
              <span className="pf-sub">Share of evaluated SLA assertions (rule × run, and rule × transaction) that did not breach the critical threshold. Rules without data are excluded.</span>
            </div>
          </div>
          <div className="kpis pf-mt" style={{ gridTemplateColumns: 'repeat(3, minmax(0, 1fr))' }}>
            <Kpi label="Runs evaluated" value={fmtNum(evaluated.length)} />
            <Kpi label="Fully passing" value={fmtNum(fullyPassing)} sub={evaluated.length ? fmtPct((fullyPassing / evaluated.length) * 100, 0) : undefined} status={evaluated.length ? (fullyPassing === evaluated.length ? 'pass' : 'warn') : null} />
            <Kpi label="Violations" value={fmtNum(totalViolations)} status={totalViolations ? 'fail' : evaluated.length ? 'pass' : null} />
          </div>
        </Card>
        <Chart title="Per-run SLA pass %" subtitle="chronological" option={barOption} height={226}
          empty={evaluated.length ? null : 'No SLA-evaluated runs in this range'}
          table={{ columns: ['Run ID', 'Test', 'Pass %', 'Violations'], rows: evaluated.map((r) => [r.runKey, r.testName, r.passPct == null ? null : +r.passPct.toFixed(2), r.violations]) }} />
        <Card title="Top violations" noPad>
          {!top.length ? <EmptyState icon={<ShieldCheck size={20} />} title="No violations">No SLA rule breached its critical threshold in this range.</EmptyState> : (
            <div className="table-wrap" style={{ maxHeight: 260 }}>
              <table className="table">
                <thead><tr><th>Metric</th><th>Transaction</th><th className="r">Breaches</th><th /></tr></thead>
                <tbody>
                  {top.map((v, i) => {
                    const runKey = v.lastRunKey ?? v.runKey ?? latestViolating?.runKey;
                    const max = Math.max(...top.map((x) => x.count), 1);
                    return (
                      <tr key={i}>
                        <td><b>{SHORT[v.metric] ?? v.metric}</b></td>
                        <td className="mono" style={{ maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis' }} title={v.transaction ?? 'Whole run'}>{v.transaction ?? <span className="muted">whole run</span>}</td>
                        <td className="r"><div className="row" style={{ justifyContent: 'flex-end' }}><div className="pf-progress" style={{ width: 50 }}><div style={{ width: `${(v.count / max) * 100}%`, background: 'var(--fail)' }} /></div><span className="num">{v.count}</span></div></td>
                        <td>{runKey && <Link className="btn btn-ghost btn-sm" to={`/runs/${runKey}/sla`} title={`Open the SLA tab of ${runKey}${v.lastRunKey || v.runKey ? '' : ' (latest run with violations)'}`}>View <ArrowUpRight size={12} /></Link>}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
      <Card title="Runs in range" noPad actions={<span className="muted" style={{ fontSize: 12 }}><Gauge size={12} style={{ verticalAlign: -2 }} /> Click a Run ID to open its SLA tab</span>}>
        <DataTable rows={[...runs].reverse()} columns={runCols} rowKey={(r) => r.runKey} pageSize={10} exportName="sla-runs" maxHeight={380}
          empty="No SLA-evaluated runs in the selected range. Assign an SLA profile to a test to start evaluating runs." />
      </Card>
    </div>
  );
}

function PassBar({ v }: { v: number | null }) {
  if (v == null) return <span className="muted">no data</span>;
  const color = v >= 100 ? 'var(--pass)' : v >= 80 ? 'var(--warn)' : 'var(--fail)';
  return (
    <div className="row" style={{ justifyContent: 'flex-end' }}>
      <div className="pf-progress" style={{ width: 70 }}><div style={{ width: `${Math.min(100, v)}%`, background: color }} /></div>
      <span className="num" style={{ minWidth: 48, textAlign: 'right' }}>{fmtPct(v, 1)}</span>
    </div>
  );
}
