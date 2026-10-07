import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { AppWindow, Boxes, FlaskConical, FolderKanban, Layers, Lock, Rocket, Server as ServerIcon, Workflow } from 'lucide-react';
import { api } from '@/services/api';
import { Drawer, FormField, Notice, fieldErrors, friendlyError, toast } from './common';
import {
  ENV_TYPES, SERVER_ROLES, SERVICE_KINDS, TEST_TYPES, clean, intOrNull, numOrNull, useApplications, useEnvironments, useInvalidateInventory, useProjects, useServers, useServices, useSlaProfiles,
  type Application, type Environment, type Project, type Release, type Server, type Service, type TestRow,
} from './data';

/* ------------------------------------------------------------------ form state */
type Vals = Record<string, string>;
function useForm<T extends Vals>(initial: () => T, deps: unknown[]) {
  const [v, setV] = useState<T>(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { setV(initial()); setErrors({}); setFormError(null); }, deps);
  const set = (k: keyof T, val: string) => { setV((o) => ({ ...o, [k]: val })); if (errors[k as string]) setErrors((e) => { const n = { ...e }; delete n[k as string]; return n; }); };
  const bind = (k: keyof T) => ({
    id: `f-${String(k)}`, name: String(k), value: v[k] ?? '', 'aria-invalid': !!errors[k as string] || undefined,
    onChange: (e: { target: { value: string } }) => set(k, e.target.value),
  });
  /** run client validation, then the request; maps server validation to fields */
  const submit = async (validate: (v: T) => Record<string, string>, run: () => Promise<void>) => {
    const errs = validate(v);
    setErrors(errs);
    setFormError(null);
    if (Object.keys(errs).length) return;
    setSaving(true);
    try { await run(); } catch (e) {
      setErrors(fieldErrors(e));
      setFormError(friendlyError(e));
    } finally { setSaving(false); }
  };
  return { v, set, bind, errors, saving, formError, submit, setV };
}

function Foot({ onClose, saving, label, form }: { onClose: () => void; saving: boolean; label: string; form: string }) {
  return (
    <>
      <button type="button" className="btn" onClick={onClose}>Cancel</button>
      <button type="submit" form={form} className="btn btn-primary" disabled={saving}>{saving ? 'Saving…' : label}</button>
    </>
  );
}
const FormErr = ({ msg }: { msg: string | null }) => (msg ? <div className="error-box" role="alert" style={{ marginBottom: 12 }}>{msg}</div> : null);
const Section = ({ title, children, hint }: { title: string; children: ReactNode; hint?: ReactNode }) => (
  <fieldset className="inv-fieldset"><legend>{title}</legend>{hint && <div className="inv-field-hint" style={{ marginTop: -4, marginBottom: 8 }}>{hint}</div>}<div className="inv-form-grid">{children}</div></fieldset>
);
const req = (s: string | undefined) => !s || !s.trim();
const slug = (s: string) => s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 41);

/* ================================================================== Project */
export function ProjectForm({ open, onClose, project, onSaved }: { open: boolean; onClose: () => void; project?: Project | null; onSaved?: (p: Project) => void }) {
  const inv = useInvalidateInventory();
  const [keyTouched, setKeyTouched] = useState(false);
  const f = useForm(() => ({ key: project?.key ?? '', name: project?.name ?? '', description: project?.description ?? '' }), [open, project?.id]);
  useEffect(() => setKeyTouched(!!project), [open, project]);
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    f.submit((v) => {
      const er: Record<string, string> = {};
      if (req(v.name)) er.name = 'Name is required';
      if (!project && !/^[a-z0-9][a-z0-9-]{1,40}$/.test(v.key)) er.key = '2–41 chars: lowercase letters, digits and dashes; must start with a letter or digit';
      return er;
    }, async () => {
      const row = project
        ? await api.patch<Project>(`/projects/${project.id}`, { name: f.v.name.trim(), description: f.v.description.trim() || null })
        : await api.post<Project>('/projects', { key: f.v.key, name: f.v.name.trim(), description: f.v.description.trim() || undefined });
      inv();
      toast.success(project ? `Project “${row.name}” updated` : `Project “${row.name}” created`);
      onSaved?.(row);
      onClose();
    });
  };
  return (
    <Drawer open={open} onClose={onClose} icon={<FolderKanban size={18} />} title={project ? 'Edit project' : 'New project'} subtitle="Projects group applications, environments, tests and runs."
      footer={<Foot onClose={onClose} saving={f.saving} label={project ? 'Save changes' : 'Create project'} form="project-form" />}>
      <form id="project-form" onSubmit={onSubmit} noValidate>
        <FormErr msg={f.formError} />
        <div className="inv-form-grid">
          <FormField label="Name" required error={f.errors.name} htmlFor="f-name" span={2}>
            <input className="input" {...f.bind('name')} placeholder="e.g. Payments Platform" maxLength={120}
              onChange={(e) => { f.set('name', e.target.value); if (!keyTouched && !project) f.set('key', slug(e.target.value)); }} />
          </FormField>
          <FormField label="Key" required={!project} error={f.errors.key} htmlFor="f-key" span={2}
            hint={project ? 'The key is permanent (used by CI, API keys and the collector).' : 'Used by CI pipelines, API keys and the collector (PERFMON_PROJECT). Cannot be changed later.'}>
            <input className="input mono" {...f.bind('key')} disabled={!!project} placeholder="payments" maxLength={41}
              onChange={(e) => { setKeyTouched(true); f.set('key', e.target.value.toLowerCase()); }} />
          </FormField>
          <FormField label="Description" error={f.errors.description} htmlFor="f-description" span={2}>
            <textarea className="textarea" rows={4} {...f.bind('description')} maxLength={2000} placeholder="What is being tested, who owns it…" />
          </FormField>
        </div>
      </form>
    </Drawer>
  );
}

/* ================================================================== Application */
export function ApplicationForm({ open, onClose, app, projectId, onSaved }: { open: boolean; onClose: () => void; app?: Application | null; projectId?: string | null; onSaved?: (a: Application) => void }) {
  const inv = useInvalidateInventory();
  const projects = useProjects();
  const f = useForm(() => ({
    projectId: app?.project_id ?? projectId ?? '', code: app?.code ?? '', name: app?.name ?? '', description: app?.description ?? '', owner: app?.owner ?? '', team: app?.team ?? '',
    technology: app?.technology ?? '', repository: app?.repository ?? '', version: app?.version ?? '',
  }), [open, app?.id, projectId]);
  useEffect(() => { if (open && !f.v.projectId && projects.data?.length === 1) f.set('projectId', projects.data[0].id); }, [open, projects.data]); // eslint-disable-line
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    f.submit((v) => {
      const er: Record<string, string> = {};
      if (!app && req(v.projectId)) er.projectId = 'Select a project';
      if (req(v.name)) er.name = 'Name is required';
      if (req(v.code)) er.code = 'Application ID is required';
      return er;
    }, async () => {
      const body = clean({ code: f.v.code.trim(), name: f.v.name.trim(), description: f.v.description.trim(), owner: f.v.owner.trim(), team: f.v.team.trim(), technology: f.v.technology.trim(), repository: f.v.repository.trim(), version: f.v.version.trim() },
        app ? ['description', 'owner', 'team', 'technology', 'repository', 'version'] : []);
      const row = app ? await api.patch<Application>(`/applications/${app.id}`, body) : await api.post<Application>('/applications', { ...body, projectId: f.v.projectId });
      inv();
      toast.success(app ? `Application “${row.name}” updated` : `Application “${row.name}” created`);
      onSaved?.(row);
      onClose();
    });
  };
  return (
    <Drawer open={open} onClose={onClose} icon={<AppWindow size={18} />} title={app ? 'Edit application' : 'New application'} subtitle="The system under test. Environments and tests belong to an application."
      footer={<Foot onClose={onClose} saving={f.saving} label={app ? 'Save changes' : 'Create application'} form="app-form" />}>
      <form id="app-form" onSubmit={onSubmit} noValidate>
        <FormErr msg={f.formError} />
        <Section title="Identity">
          {!app && (
            <FormField label="Project" required error={f.errors.projectId} htmlFor="f-projectId" span={2}>
              <select className="select" {...f.bind('projectId')} disabled={!!projectId}>
                <option value="">Select a project…</option>
                {projects.data?.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.key})</option>)}
              </select>
            </FormField>
          )}
          <FormField label="Application name" required error={f.errors.name} htmlFor="f-name">
            <input className="input" {...f.bind('name')} placeholder="Payments API" maxLength={120}
              onChange={(e) => { f.set('name', e.target.value); if (!app && (!f.v.code || f.v.code === slug(f.v.name))) f.set('code', slug(e.target.value)); }} />
          </FormField>
          <FormField label="Application ID / code" required error={f.errors.code} htmlFor="f-code" hint="Unique within the project">
            <input className="input mono" {...f.bind('code')} placeholder="payments-api" maxLength={60} />
          </FormField>
          <FormField label="Description" error={f.errors.description} htmlFor="f-description" span={2}>
            <textarea className="textarea" rows={3} {...f.bind('description')} maxLength={2000} />
          </FormField>
        </Section>
        <Section title="Ownership & source">
          <FormField label="Owner" error={f.errors.owner} htmlFor="f-owner"><input className="input" {...f.bind('owner')} placeholder="jane.doe" maxLength={120} /></FormField>
          <FormField label="Team" error={f.errors.team} htmlFor="f-team"><input className="input" {...f.bind('team')} placeholder="Payments Squad" maxLength={120} /></FormField>
          <FormField label="Technology" error={f.errors.technology} htmlFor="f-technology"><input className="input" {...f.bind('technology')} placeholder="Java 21 · Spring Boot" maxLength={200} /></FormField>
          <FormField label="Version" error={f.errors.version} htmlFor="f-version"><input className="input mono" {...f.bind('version')} placeholder="2.14.0" maxLength={60} /></FormField>
          <FormField label="Repository" error={f.errors.repository} htmlFor="f-repository" span={2}><input className="input mono" {...f.bind('repository')} placeholder="https://git.example.com/payments/api" maxLength={500} /></FormField>
        </Section>
      </form>
    </Drawer>
  );
}

/* ================================================================== Environment */
export function EnvironmentForm({ open, onClose, env, applicationId, projectId, onSaved }: {
  open: boolean; onClose: () => void; env?: Environment | null; applicationId?: string | null; projectId?: string | null; onSaved?: (e: Environment) => void;
}) {
  const inv = useInvalidateInventory();
  const apps = useApplications(projectId);
  const f = useForm(() => ({
    applicationId: env?.application_id ?? applicationId ?? '', name: env?.name ?? '', type: env?.type ?? 'PERFORMANCE', description: env?.description ?? '', baseUrl: env?.base_url ?? '',
    config: env?.config && Object.keys(env.config).length ? JSON.stringify(env.config, null, 2) : '',
  }), [open, env?.id, applicationId]);
  useEffect(() => { if (open && !env && !f.v.applicationId && apps.data?.length === 1) f.set('applicationId', apps.data[0].id); }, [open, apps.data]); // eslint-disable-line
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    let config: Record<string, unknown> | undefined;
    f.submit((v) => {
      const er: Record<string, string> = {};
      if (!env && req(v.applicationId)) er.applicationId = 'Select an application';
      if (req(v.name)) er.name = 'Name is required';
      if (v.baseUrl.trim() && !/^https?:\/\/\S+$/i.test(v.baseUrl.trim())) er.baseUrl = 'Must be an http(s) URL';
      if (v.config.trim()) {
        try {
          const c = JSON.parse(v.config);
          if (!c || typeof c !== 'object' || Array.isArray(c)) er.config = 'Configuration must be a JSON object, e.g. {"region":"eu-west-1"}';
          else config = c;
        } catch (x) { er.config = `Invalid JSON: ${(x as Error).message}`; }
      } else config = {};
      return er;
    }, async () => {
      const body = { name: f.v.name.trim(), type: f.v.type, description: f.v.description.trim() || null, baseUrl: f.v.baseUrl.trim() || null, config };
      const row = env ? await api.patch<Environment>(`/environments/${env.id}`, body) : await api.post<Environment>('/environments', { ...body, applicationId: f.v.applicationId });
      inv();
      toast.success(env ? `Environment “${row.name}” updated` : `Environment “${row.name}” created`);
      onSaved?.(row);
      onClose();
    });
  };
  return (
    <Drawer open={open} onClose={onClose} icon={<Layers size={18} />} title={env ? 'Edit environment' : 'New environment'} subtitle="Where tests execute: DEV, QA, SIT, UAT, PERFORMANCE, STAGING or PRODUCTION."
      footer={<Foot onClose={onClose} saving={f.saving} label={env ? 'Save changes' : 'Create environment'} form="env-form" />}>
      <form id="env-form" onSubmit={onSubmit} noValidate>
        <FormErr msg={f.formError} />
        <div className="inv-form-grid">
          {!env && (
            <FormField label="Application" required error={f.errors.applicationId} htmlFor="f-applicationId" span={2}>
              <select className="select" {...f.bind('applicationId')} disabled={!!applicationId}>
                <option value="">Select an application…</option>
                {apps.data?.map((a) => <option key={a.id} value={a.id}>{a.name} · {a.project_name}</option>)}
              </select>
            </FormField>
          )}
          <FormField label="Name" required error={f.errors.name} htmlFor="f-name"><input className="input" {...f.bind('name')} placeholder="Performance" maxLength={80} /></FormField>
          <FormField label="Type" required error={f.errors.type} htmlFor="f-type">
            <select className="select" {...f.bind('type')}>{ENV_TYPES.map((t) => <option key={t}>{t}</option>)}</select>
          </FormField>
          <FormField label="Base URL" error={f.errors.baseUrl} htmlFor="f-baseUrl" span={2}><input className="input mono" {...f.bind('baseUrl')} placeholder="https://perf.payments.example.com" maxLength={500} /></FormField>
          <FormField label="Description" error={f.errors.description} htmlFor="f-description" span={2}><textarea className="textarea" rows={2} {...f.bind('description')} maxLength={2000} /></FormField>
          <FormField label="Configuration (JSON)" error={f.errors.config} htmlFor="f-config" span={2} hint="Non-secret settings only (region, instance sizes, feature flags). Never store passwords or tokens here.">
            <textarea className="textarea mono" rows={6} {...f.bind('config')} placeholder={'{\n  "region": "eu-west-1",\n  "replicas": 4\n}'} spellCheck={false} />
          </FormField>
        </div>
      </form>
    </Drawer>
  );
}

/* ================================================================== Performance test */
const LP_FIELDS = ['virtualUsers', 'rampUpSec', 'rampDownSec', 'durationSec', 'targetTps', 'threadGroup', 'thinkTimeMs'] as const;
export function TestForm({ open, onClose, test, projectId, applicationId, environmentId, onSaved }: {
  open: boolean; onClose: () => void; test?: TestRow | null; projectId?: string | null; applicationId?: string | null; environmentId?: string | null; onSaved?: (t: TestRow) => void;
}) {
  const inv = useInvalidateInventory();
  const apps = useApplications(projectId);
  const initial = () => ({
    name: test?.name ?? '', description: test?.description ?? '', applicationId: test?.application_id ?? applicationId ?? '', environmentId: test?.environment_id ?? environmentId ?? '',
    testType: test?.test_type ?? 'LOAD', slaProfileId: test?.sla_profile_id ?? '', owner: test?.owner ?? '', tags: (test?.tags ?? []).join(', '),
    virtualUsers: test?.virtual_users?.toString() ?? '', rampUpSec: test?.ramp_up_sec?.toString() ?? '', rampDownSec: test?.ramp_down_sec?.toString() ?? '',
    durationSec: test?.duration_sec?.toString() ?? '', targetTps: test?.target_tps != null ? String(Number(test.target_tps)) : '', threadGroup: test?.thread_group ?? '', thinkTimeMs: test?.think_time_ms?.toString() ?? '',
  });
  const f = useForm(initial, [open, test?.id, applicationId, environmentId]);
  const app = apps.data?.find((a) => a.id === f.v.applicationId);
  const envs = useEnvironments({ applicationId: f.v.applicationId || null }, !!f.v.applicationId);
  const sla = useSlaProfiles(test?.project_id ?? app?.project_id ?? projectId ?? null);
  useEffect(() => { if (open && !test && !f.v.applicationId && apps.data?.length === 1) f.set('applicationId', apps.data[0].id); }, [open, apps.data]); // eslint-disable-line
  useEffect(() => { if (open && !test && !f.v.environmentId && envs.data?.length === 1) f.set('environmentId', envs.data[0].id); }, [open, envs.data]); // eslint-disable-line
  const duration = intOrNull(f.v.durationSec);

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    f.submit((v) => {
      const er: Record<string, string> = {};
      if (req(v.name)) er.name = 'Name is required';
      if (!test && req(v.applicationId)) er.applicationId = 'Select an application';
      if (!test && req(v.environmentId)) er.environmentId = 'Select an environment';
      for (const k of ['virtualUsers', 'rampUpSec', 'rampDownSec', 'durationSec', 'thinkTimeMs'] as const) {
        const n = intOrNull(v[k]);
        if (Number.isNaN(n) || (n != null && n < 0)) er[k] = 'Whole number ≥ 0';
      }
      const tps = numOrNull(v.targetTps);
      if (Number.isNaN(tps) || (tps != null && tps < 0)) er.targetTps = 'Number ≥ 0';
      return er;
    }, async () => {
      const v = f.v;
      const loadProfile = clean({ virtualUsers: intOrNull(v.virtualUsers), rampUpSec: intOrNull(v.rampUpSec), rampDownSec: intOrNull(v.rampDownSec), durationSec: intOrNull(v.durationSec), targetTps: numOrNull(v.targetTps), threadGroup: v.threadGroup.trim() || null, thinkTimeMs: intOrNull(v.thinkTimeMs) });
      const tags = v.tags.split(',').map((t) => t.trim()).filter(Boolean);
      const common = { name: v.name.trim(), description: v.description.trim() || null, testType: v.testType, slaProfileId: v.slaProfileId || null, owner: v.owner.trim() || null, tags };
      let row: TestRow;
      if (test) {
        const init = initial();
        const lpChanged = LP_FIELDS.some((k) => (init[k] ?? '') !== (v[k] ?? ''));
        row = await api.patch<TestRow>(`/tests/${test.id}`, { ...common, ...(lpChanged ? { loadProfile } : {}) });
        toast.success(lpChanged ? `Saved — load profile is now configuration v${row.config_version}` : `Test “${row.name}” updated`);
      } else {
        row = await api.post<TestRow>('/tests', { ...common, applicationId: v.applicationId, environmentId: v.environmentId, loadProfile });
        toast.success(`Performance test “${row.name}” created`);
      }
      inv();
      onSaved?.(row);
      onClose();
    });
  };
  const num = (k: (typeof LP_FIELDS)[number], label: string, unit: string, ph: string) => (
    <FormField label={`${label}${unit ? ` (${unit})` : ''}`} error={f.errors[k] ?? (k === 'virtualUsers' || k === 'targetTps' ? f.errors.loadProfile : undefined)} htmlFor={`f-${k}`}>
      <input className="input num" inputMode="decimal" {...f.bind(k)} placeholder={ph} />
    </FormField>
  );
  return (
    <Drawer open={open} onClose={onClose} width={620} icon={<FlaskConical size={18} />} title={test ? 'Edit performance test' : 'New performance test'}
      subtitle={test ? `${test.application_name} · ${test.environment_name}` : 'Define what to run, where, and with which load profile.'}
      footer={<Foot onClose={onClose} saving={f.saving} label={test ? 'Save changes' : 'Create test'} form="test-form" />}>
      <form id="test-form" onSubmit={onSubmit} noValidate>
        <FormErr msg={f.formError} />
        <Section title="Test">
          <FormField label="Name" required error={f.errors.name} htmlFor="f-name" span={2}><input className="input" {...f.bind('name')} placeholder="Checkout – peak load" maxLength={200} /></FormField>
          {!test && (
            <>
              <FormField label="Application" required error={f.errors.applicationId} htmlFor="f-applicationId">
                <select className="select" {...f.bind('applicationId')} disabled={!!applicationId} onChange={(e) => { f.set('applicationId', e.target.value); f.set('environmentId', ''); f.set('slaProfileId', ''); }}>
                  <option value="">Select…</option>
                  {apps.data?.map((a) => <option key={a.id} value={a.id}>{a.name}{projectId ? '' : ` · ${a.project_name}`}</option>)}
                </select>
              </FormField>
              <FormField label="Environment" required error={f.errors.environmentId} htmlFor="f-environmentId" hint={f.v.applicationId && envs.data && !envs.data.length ? 'This application has no environments yet.' : undefined}>
                <select className="select" {...f.bind('environmentId')} disabled={!f.v.applicationId || !!environmentId}>
                  <option value="">{f.v.applicationId ? 'Select…' : 'Select an application first'}</option>
                  {envs.data?.map((en) => <option key={en.id} value={en.id}>{en.name} ({en.type})</option>)}
                </select>
              </FormField>
            </>
          )}
          <FormField label="Test type" error={f.errors.testType} htmlFor="f-testType">
            <select className="select" {...f.bind('testType')}>{TEST_TYPES.map((t) => <option key={t}>{t}</option>)}</select>
          </FormField>
          <FormField label="SLA profile" error={f.errors.slaProfileId} htmlFor="f-slaProfileId" hint={sla.data && !sla.data.length ? 'No SLA profiles in this project yet (configure under SLA).' : undefined}>
            <select className="select" {...f.bind('slaProfileId')}>
              <option value="">None</option>
              {sla.data?.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </FormField>
          <FormField label="Owner" error={f.errors.owner} htmlFor="f-owner"><input className="input" {...f.bind('owner')} placeholder="jane.doe" maxLength={120} /></FormField>
          <FormField label="Tags" error={f.errors.tags} htmlFor="f-tags" hint="Comma separated"><input className="input" {...f.bind('tags')} placeholder="checkout, nightly" /></FormField>
          <FormField label="Description" error={f.errors.description} htmlFor="f-description" span={2}><textarea className="textarea" rows={2} {...f.bind('description')} maxLength={5000} /></FormField>
        </Section>
        <Section title="Load profile" hint={test ? 'Changing any load-profile value creates a new configuration version; earlier runs keep the version they used.' : 'Stored as configuration v1.'}>
          {num('virtualUsers', 'Virtual users', '', '100')}
          {num('targetTps', 'Target TPS', 'req/s', '50')}
          {num('rampUpSec', 'Ramp-up', 's', '60')}
          {num('rampDownSec', 'Ramp-down', 's', '30')}
          {num('durationSec', 'Duration', 's', '1800')}
          {num('thinkTimeMs', 'Think time', 'ms', '1000')}
          <FormField label="Thread group" error={f.errors.threadGroup} htmlFor="f-threadGroup" span={2} hint={duration && !Number.isNaN(duration) ? `Duration ≈ ${Math.floor(duration / 60)} min ${duration % 60}s` : undefined}>
            <input className="input" {...f.bind('threadGroup')} placeholder="Checkout users" maxLength={200} />
          </FormField>
        </Section>
      </form>
    </Drawer>
  );
}

/* ================================================================== Release */
export function ReleaseForm({ open, onClose, release, projectId, onSaved }: { open: boolean; onClose: () => void; release?: Release | null; projectId?: string | null; onSaved?: (r: Release) => void }) {
  const inv = useInvalidateInventory();
  const projects = useProjects();
  const toLocal = (s?: string | null) => { if (!s) return ''; const d = new Date(s); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16); };
  const f = useForm(() => ({
    projectId: release?.project_id ?? projectId ?? '', applicationId: release?.application_id ?? '', environmentId: release?.environment_id ?? '', name: release?.name ?? '', version: release?.version ?? '',
    buildNumber: release?.build_number ?? '', branch: release?.branch ?? '', commit: release?.commit_sha ?? '', deploymentDate: toLocal(release?.deployment_date), notes: release?.notes ?? '',
  }), [open, release?.id, projectId]);
  const apps = useApplications(f.v.projectId || null);
  const envs = useEnvironments({ applicationId: f.v.applicationId || null }, !!f.v.applicationId);
  useEffect(() => { if (open && !f.v.projectId && projects.data?.length === 1) f.set('projectId', projects.data[0].id); }, [open, projects.data]); // eslint-disable-line
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    f.submit((v) => {
      const er: Record<string, string> = {};
      if (!release && req(v.projectId)) er.projectId = 'Select a project';
      if (req(v.name)) er.name = 'Name is required';
      if (req(v.version)) er.version = 'Version is required';
      return er;
    }, async () => {
      const v = f.v;
      const body = {
        applicationId: v.applicationId || null, environmentId: v.environmentId || null, name: v.name.trim(), version: v.version.trim(), buildNumber: v.buildNumber.trim() || null,
        branch: v.branch.trim() || null, commit: v.commit.trim() || null, deploymentDate: v.deploymentDate ? new Date(v.deploymentDate).toISOString() : null, notes: v.notes.trim() || null,
      };
      const row = release ? await api.patch<Release>(`/releases/${release.id}`, body) : await api.post<Release>('/releases', { ...clean(body), projectId: v.projectId });
      inv();
      toast.success(release ? `Release ${row.version} updated` : `Release ${row.version} created${row.deployment_date ? ' — deployment event recorded' : ''}`);
      onSaved?.(row);
      onClose();
    });
  };
  return (
    <Drawer open={open} onClose={onClose} icon={<Rocket size={18} />} title={release ? 'Edit release' : 'New release'} subtitle="Associate runs with a deployable version to track performance per release."
      footer={<Foot onClose={onClose} saving={f.saving} label={release ? 'Save changes' : 'Create release'} form="release-form" />}>
      <form id="release-form" onSubmit={onSubmit} noValidate>
        <FormErr msg={f.formError} />
        <Section title="Release">
          {!release && (
            <FormField label="Project" required error={f.errors.projectId} htmlFor="f-projectId" span={2}>
              <select className="select" {...f.bind('projectId')} disabled={!!projectId} onChange={(e) => { f.set('projectId', e.target.value); f.set('applicationId', ''); f.set('environmentId', ''); }}>
                <option value="">Select a project…</option>
                {projects.data?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </FormField>
          )}
          <FormField label="Name" required error={f.errors.name} htmlFor="f-name"><input className="input" {...f.bind('name')} placeholder="October release" maxLength={120} /></FormField>
          <FormField label="Version" required error={f.errors.version} htmlFor="f-version" hint="Unique within the project"><input className="input mono" {...f.bind('version')} placeholder="2026.10.1" maxLength={60} /></FormField>
          <FormField label="Application" error={f.errors.applicationId} htmlFor="f-applicationId">
            <select className="select" {...f.bind('applicationId')} onChange={(e) => { f.set('applicationId', e.target.value); f.set('environmentId', ''); }}>
              <option value="">Any</option>
              {apps.data?.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </FormField>
          <FormField label="Environment" error={f.errors.environmentId} htmlFor="f-environmentId">
            <select className="select" {...f.bind('environmentId')} disabled={!f.v.applicationId}>
              <option value="">Any</option>
              {envs.data?.map((en) => <option key={en.id} value={en.id}>{en.name} ({en.type})</option>)}
            </select>
          </FormField>
        </Section>
        <Section title="Source & deployment">
          <FormField label="Build number" error={f.errors.buildNumber} htmlFor="f-buildNumber"><input className="input mono" {...f.bind('buildNumber')} placeholder="1287" maxLength={60} /></FormField>
          <FormField label="Branch" error={f.errors.branch} htmlFor="f-branch"><input className="input mono" {...f.bind('branch')} placeholder="release/2026.10" maxLength={200} /></FormField>
          <FormField label="Commit" error={f.errors.commit} htmlFor="f-commit"><input className="input mono" {...f.bind('commit')} placeholder="a1b2c3d" maxLength={100} /></FormField>
          <FormField label="Deployment date" error={f.errors.deploymentDate} htmlFor="f-deploymentDate" hint={!release ? 'Creates a DEPLOYMENT event on the timeline' : undefined}>
            <input className="input" type="datetime-local" {...f.bind('deploymentDate')} />
          </FormField>
          <FormField label="Notes" error={f.errors.notes} htmlFor="f-notes" span={2}><textarea className="textarea" rows={3} {...f.bind('notes')} maxLength={5000} /></FormField>
        </Section>
      </form>
    </Drawer>
  );
}

/* ================================================================== Server */
export function ServerForm({ open, onClose, server, projectId, onSaved }: { open: boolean; onClose: () => void; server?: Server | null; projectId?: string | null; onSaved?: (s: Server) => void }) {
  const inv = useInvalidateInventory();
  const projects = useProjects();
  const f = useForm(() => ({
    projectId: server?.project_id ?? projectId ?? '', environmentId: server?.environment_id ?? '', applicationId: server?.application_id ?? '', name: server?.name ?? '', hostname: server?.hostname ?? '',
    ipAddress: server?.ip_address ?? '', os: server?.os ?? '', cpuCores: server?.cpu_cores?.toString() ?? '', memoryMb: server?.memory_mb?.toString() ?? '', diskGb: server?.disk_gb?.toString() ?? '',
    role: server?.role ?? 'app', tags: Object.entries(server?.tags ?? {}).map(([k, v]) => `${k}=${v}`).join('\n'),
  }), [open, server?.id, projectId]);
  const apps = useApplications(f.v.projectId || null);
  const envs = useEnvironments({ projectId: f.v.projectId || null }, !!f.v.projectId);
  useEffect(() => { if (open && !f.v.projectId && projects.data?.length === 1) f.set('projectId', projects.data[0].id); }, [open, projects.data]); // eslint-disable-line
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    let tags: Record<string, string> = {};
    f.submit((v) => {
      const er: Record<string, string> = {};
      if (!server && req(v.projectId)) er.projectId = 'Select a project';
      if (req(v.name)) er.name = 'Name is required';
      for (const k of ['cpuCores', 'memoryMb', 'diskGb'] as const) { const n = intOrNull(v[k]); if (Number.isNaN(n) || (n != null && n < 0)) er[k] = 'Whole number ≥ 0'; }
      if (v.ipAddress.trim() && !/^[0-9a-fA-F:.]+$/.test(v.ipAddress.trim())) er.ipAddress = 'IPv4 or IPv6 address';
      tags = {};
      for (const line of v.tags.split('\n').map((l) => l.trim()).filter(Boolean)) {
        const i = line.indexOf('=');
        if (i < 1) { er.tags = `“${line}” — use key=value`; break; }
        tags[line.slice(0, i).trim()] = line.slice(i + 1).trim();
      }
      if (Object.keys(tags).some((k) => /pass|secret|token|key|credential/i.test(k))) er.tags = 'Tags must not contain credentials or secrets';
      return er;
    }, async () => {
      const v = f.v;
      const body = {
        environmentId: v.environmentId || null, applicationId: v.applicationId || null, name: v.name.trim(), hostname: v.hostname.trim() || null, ipAddress: v.ipAddress.trim() || null, os: v.os.trim() || null,
        cpuCores: intOrNull(v.cpuCores), memoryMb: intOrNull(v.memoryMb), diskGb: intOrNull(v.diskGb), role: v.role || null, tags,
      };
      const row = server ? await api.patch<Server>(`/servers/${server.id}`, body) : await api.post<Server>('/servers', { ...body, projectId: v.projectId });
      inv();
      toast.success(server ? `Server “${row.name}” updated` : `Server “${row.name}” registered`);
      onSaved?.(row);
      onClose();
    });
  };
  return (
    <Drawer open={open} onClose={onClose} icon={<ServerIcon size={18} />} title={server ? 'Edit server' : 'Register server'} subtitle="Inventory only — metrics arrive from the Perfmon Collector or integrations."
      footer={<Foot onClose={onClose} saving={f.saving} label={server ? 'Save changes' : 'Register server'} form="server-form" />}>
      <form id="server-form" onSubmit={onSubmit} noValidate>
        <Notice kind="warn" icon={<Lock size={15} />}>Perfmon never stores server credentials (passwords, SSH keys, tokens). Metrics are pushed by the collector using a scoped API key.</Notice>
        <div style={{ height: 12 }} />
        <FormErr msg={f.formError} />
        <Section title="Placement">
          {!server && (
            <FormField label="Project" required error={f.errors.projectId} htmlFor="f-projectId" span={2}>
              <select className="select" {...f.bind('projectId')} onChange={(e) => { f.set('projectId', e.target.value); f.set('environmentId', ''); f.set('applicationId', ''); }}>
                <option value="">Select a project…</option>
                {projects.data?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </FormField>
          )}
          <FormField label="Environment" error={f.errors.environmentId} htmlFor="f-environmentId">
            <select className="select" {...f.bind('environmentId')} disabled={!f.v.projectId}>
              <option value="">Unassigned</option>
              {envs.data?.map((en) => <option key={en.id} value={en.id}>{en.name} · {en.application_name}</option>)}
            </select>
          </FormField>
          <FormField label="Application" error={f.errors.applicationId} htmlFor="f-applicationId">
            <select className="select" {...f.bind('applicationId')} disabled={!f.v.projectId}>
              <option value="">Shared / none</option>
              {apps.data?.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </FormField>
          <FormField label="Role" error={f.errors.role} htmlFor="f-role">
            <select className="select" {...f.bind('role')}>{SERVER_ROLES.map((r) => <option key={r}>{r}</option>)}</select>
          </FormField>
        </Section>
        <Section title="Host">
          <FormField label="Server name" required error={f.errors.name} htmlFor="f-name" hint="Must match PERFMON_SERVER on the collector"><input className="input mono" {...f.bind('name')} placeholder="pay-app-01" maxLength={200} /></FormField>
          <FormField label="Hostname" error={f.errors.hostname} htmlFor="f-hostname"><input className="input mono" {...f.bind('hostname')} placeholder="pay-app-01.perf.internal" maxLength={255} /></FormField>
          <FormField label="IP address" error={f.errors.ipAddress} htmlFor="f-ipAddress"><input className="input mono" {...f.bind('ipAddress')} placeholder="10.0.4.21" maxLength={64} /></FormField>
          <FormField label="Operating system" error={f.errors.os} htmlFor="f-os"><input className="input" {...f.bind('os')} placeholder="Ubuntu 24.04" maxLength={120} /></FormField>
          <FormField label="CPU cores" error={f.errors.cpuCores} htmlFor="f-cpuCores"><input className="input num" inputMode="numeric" {...f.bind('cpuCores')} placeholder="8" /></FormField>
          <FormField label="Memory (MB)" error={f.errors.memoryMb} htmlFor="f-memoryMb" hint={intOrNull(f.v.memoryMb) ? `≈ ${((intOrNull(f.v.memoryMb) ?? 0) / 1024).toFixed(1)} GB` : undefined}><input className="input num" inputMode="numeric" {...f.bind('memoryMb')} placeholder="16384" /></FormField>
          <FormField label="Disk (GB)" error={f.errors.diskGb} htmlFor="f-diskGb"><input className="input num" inputMode="numeric" {...f.bind('diskGb')} placeholder="200" /></FormField>
          <FormField label="Tags" error={f.errors.tags} htmlFor="f-tags" span={2} hint="One key=value per line (e.g. zone=eu-west-1a). No secrets.">
            <textarea className="textarea mono" rows={3} {...f.bind('tags')} spellCheck={false} />
          </FormField>
        </Section>
      </form>
    </Drawer>
  );
}

/* ================================================================== Service */
export function ServiceForm({ open, onClose, service, projectId, applicationId, environmentId, onSaved }: {
  open: boolean; onClose: () => void; service?: Service | null; projectId: string; applicationId?: string | null; environmentId?: string | null; onSaved?: (s: Service) => void;
}) {
  const inv = useInvalidateInventory();
  const f = useForm(() => ({
    name: service?.name ?? '', kind: service?.kind ?? 'service', technology: service?.technology ?? '', environmentId: service?.environment_id ?? environmentId ?? '', serverId: service?.server_id ?? '',
    dependsOn: (service?.depends_on ?? []).join(','),
  }), [open, service?.id, environmentId]);
  const envs = useEnvironments({ applicationId: applicationId ?? null, projectId }, open);
  const peers = useServices({ projectId, environmentId: f.v.environmentId || null });
  const servers = useServers({ projectId, environmentId: f.v.environmentId || null });
  const deps = useMemo(() => new Set(f.v.dependsOn.split(',').filter(Boolean)), [f.v.dependsOn]);
  const toggleDep = (id: string) => { const n = new Set(deps); n.has(id) ? n.delete(id) : n.add(id); f.set('dependsOn', [...n].join(',')); };
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    f.submit((v): Record<string, string> => (req(v.name) ? { name: 'Name is required' } : {}), async () => {
      const v = f.v;
      const body = { name: v.name.trim(), kind: v.kind, technology: v.technology.trim() || null, environmentId: v.environmentId || null, serverId: v.serverId || null, applicationId: applicationId ?? service?.application_id ?? null, dependsOn: [...deps] };
      const row = service ? await api.patch<Service>(`/services/${service.id}`, body) : await api.post<Service>('/services', { ...body, projectId });
      inv();
      toast.success(service ? `Service “${row.name}” updated` : `Service “${row.name}” added`);
      onSaved?.(row);
      onClose();
    });
  };
  const candidates = (peers.data ?? []).filter((s) => s.id !== service?.id);
  return (
    <Drawer open={open} onClose={onClose} icon={<Workflow size={18} />} title={service ? 'Edit service' : 'Add service'} subtitle="Services and their dependencies drive the service map and health views."
      footer={<Foot onClose={onClose} saving={f.saving} label={service ? 'Save changes' : 'Add service'} form="service-form" />}>
      <form id="service-form" onSubmit={onSubmit} noValidate>
        <FormErr msg={f.formError} />
        <div className="inv-form-grid">
          <FormField label="Name" required error={f.errors.name} htmlFor="f-name"><input className="input mono" {...f.bind('name')} placeholder="payment-service" maxLength={200} /></FormField>
          <FormField label="Kind" error={f.errors.kind} htmlFor="f-kind"><select className="select" {...f.bind('kind')}>{SERVICE_KINDS.map((k) => <option key={k}>{k}</option>)}</select></FormField>
          <FormField label="Technology" error={f.errors.technology} htmlFor="f-technology" hint={f.v.kind === 'database' ? 'PostgreSQL, MySQL, Oracle, MongoDB…' : undefined}><input className="input" {...f.bind('technology')} placeholder={f.v.kind === 'database' ? 'PostgreSQL' : 'Spring Boot'} maxLength={120} /></FormField>
          <FormField label="Environment" error={f.errors.environmentId} htmlFor="f-environmentId">
            <select className="select" {...f.bind('environmentId')} onChange={(e) => { f.set('environmentId', e.target.value); f.set('dependsOn', ''); f.set('serverId', ''); }}>
              <option value="">None</option>
              {envs.data?.map((en) => <option key={en.id} value={en.id}>{en.name} ({en.type})</option>)}
            </select>
          </FormField>
          <FormField label="Runs on server" error={f.errors.serverId} htmlFor="f-serverId" span={2}>
            <select className="select" {...f.bind('serverId')}>
              <option value="">Not specified</option>
              {servers.data?.map((s) => <option key={s.id} value={s.id}>{s.name}{s.role ? ` (${s.role})` : ''}</option>)}
            </select>
          </FormField>
          <FormField label="Depends on (calls)" error={f.errors.dependsOn} span={2} hint="Downstream services this one calls — used to lay out the service map.">
            {candidates.length ? (
              <div className="inv-checklist">
                {candidates.map((s) => (
                  <label key={s.id} className="inv-check"><input type="checkbox" checked={deps.has(s.id)} onChange={() => toggleDep(s.id)} /><Boxes size={13} className="muted" />{s.name}<span className="muted">· {s.kind}</span></label>
                ))}
              </div>
            ) : <div className="muted" style={{ fontSize: 12 }}>No other services in this environment yet.</div>}
          </FormField>
        </div>
      </form>
    </Drawer>
  );
}
