import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Clock, Link2, X } from 'lucide-react';
import { api } from '@/services/api';
import { Modal } from '@/components/ui';
import { FormField, errMsg, toast, useProjectScope } from '@/components/platform/kit';
import { RunSearch } from '@/components/analysis/shared';
import { EVENT_TYPES, fromLocalInput, parseTags, toLocalInput, typeMeta, type AnnotationRow, type EventRow } from './meta';

const invalidate = (qc: ReturnType<typeof useQueryClient>) => {
  qc.invalidateQueries({ queryKey: ['events-feed'] });
  qc.invalidateQueries({ queryKey: ['annotations-feed'] });
};

/** Linked-run selector: shows the chosen run as a chip, or a run search box. */
function RunLink({ value, onChange, onWindow }: { value: string | null; onChange: (runKey: string | null, projectId?: string) => void; onWindow?: (from: string, to: string | null) => void }) {
  if (value) {
    return (
      <div className="row wrap">
        <span className="ev-runchip"><Link2 size={12} /><span className="mono">{value}</span>
          <button type="button" className="btn btn-ghost icon-btn btn-sm" aria-label="Unlink run" onClick={() => onChange(null)}><X size={12} /></button>
        </span>
      </div>
    );
  }
  return (
    <RunSearch placeholder="Optional — search Run ID, test, build…" onPick={(r: any) => {
      onChange(r.runId, r.projectId);
      const start = r.startedAt ?? r.createdAt;
      if (onWindow && start) onWindow(start, r.endedAt ?? r.completedAt ?? null);
    }} />
  );
}

/* ------------------------------------------------------------------ annotation create / edit */

export function AnnotationForm({ open, onClose, initial, defaults }: {
  open: boolean; onClose: () => void; initial?: AnnotationRow | null; defaults?: { runKey?: string | null; projectId?: string | null };
}) {
  const qc = useQueryClient();
  const { projects, writeProjectId } = useProjectScope();
  const editing = !!initial;
  const [projectId, setProjectId] = useState('');
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [ts, setTs] = useState('');
  const [tsEnd, setTsEnd] = useState('');
  const [tags, setTags] = useState('');
  const [runKey, setRunKey] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    if (!open) return;
    setProjectId(initial?.projectId ?? defaults?.projectId ?? writeProjectId ?? '');
    setTitle(initial?.title ?? '');
    setText(initial?.text ?? '');
    setTs(toLocalInput(initial?.ts ?? Date.now()));
    setTsEnd(toLocalInput(initial?.tsEnd));
    setTags((initial?.tags ?? []).join(', '));
    setRunKey(initial?.runKey ?? defaults?.runKey ?? null);
    setTouched(false);
  }, [open, initial]); // eslint-disable-line react-hooks/exhaustive-deps

  const endBeforeStart = !!ts && !!tsEnd && new Date(tsEnd).getTime() < new Date(ts).getTime();
  const errors = { title: !title.trim() ? 'Title is required' : null, ts: !ts ? 'Start time is required' : null, tsEnd: endBeforeStart ? 'End must be after start' : null, project: !projectId ? 'Choose a project' : null };
  const invalid = Object.values(errors).some(Boolean);

  const save = useMutation({
    mutationFn: () => {
      const body = {
        title: title.trim(), text: text.trim() || null, ts: fromLocalInput(ts), tsEnd: tsEnd ? fromLocalInput(tsEnd) : null, tags: parseTags(tags), runId: runKey,
      };
      return editing ? api.patch<AnnotationRow>(`/annotations/${initial!.id}`, body) : api.post<AnnotationRow>('/annotations', { projectId, ...body });
    },
    onSuccess: () => { toast.success(editing ? 'Annotation updated' : 'Annotation added'); invalidate(qc); onClose(); },
    onError: (e) => toast.error(errMsg(e)),
  });

  const submit = () => { setTouched(true); if (!invalid) save.mutate(); };
  const show = (k: keyof typeof errors) => (touched ? errors[k] : null);

  return (
    <Modal open={open} onClose={onClose} title={editing ? 'Edit annotation' : 'Add annotation'} width={600}
      footer={<>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" onClick={submit} disabled={save.isPending}>{save.isPending ? 'Saving…' : editing ? 'Save changes' : 'Add annotation'}</button>
      </>}>
      <form className="ev-form" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <FormField label="Project" required error={show('project')} hint={editing ? 'An annotation stays in its project.' : undefined}>
          <select className="select" value={projectId} disabled={editing} onChange={(e) => { setProjectId(e.target.value); setRunKey(null); }}>
            <option value="">Select a project…</option>
            {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </FormField>
        <FormField label="Title" required error={show('title')}>
          <input className="input" value={title} maxLength={300} autoFocus placeholder="e.g. Deployed v2.3 to perf env" onChange={(e) => setTitle(e.target.value)} />
        </FormField>
        <FormField label="Details" hint="Optional. Searchable.">
          <textarea className="textarea" rows={3} value={text} maxLength={10000} placeholder="What changed, why, ticket links…" onChange={(e) => setText(e.target.value)} />
        </FormField>
        <div className="ev-form-2">
          <FormField label="Start" required error={show('ts')}>
            <div className="row">
              <input className="input" type="datetime-local" value={ts} onChange={(e) => setTs(e.target.value)} style={{ flex: 1 }} />
              <button type="button" className="btn btn-sm" title="Set to now" onClick={() => setTs(toLocalInput(Date.now()))}><Clock size={12} />Now</button>
            </div>
          </FormField>
          <FormField label="End" error={show('tsEnd') ?? (endBeforeStart ? errors.tsEnd : null)} hint="Optional — makes this a time window.">
            <div className="row">
              <input className="input" type="datetime-local" value={tsEnd} onChange={(e) => setTsEnd(e.target.value)} style={{ flex: 1 }} />
              {tsEnd && <button type="button" className="btn btn-ghost icon-btn btn-sm" aria-label="Clear end" onClick={() => setTsEnd('')}><X size={12} /></button>}
            </div>
          </FormField>
        </div>
        <FormField label="Linked run" hint="Optional. The run must belong to the selected project.">
          <RunLink value={runKey} onChange={(k, pid) => { setRunKey(k); if (k && pid && !editing) setProjectId(pid); }}
            onWindow={(from, to) => { if (!editing && !initial) { setTs(toLocalInput(from)); if (to) setTsEnd(toLocalInput(to)); } }} />
        </FormField>
        <FormField label="Tags" hint="Comma separated, e.g. deploy, v2.3, perf-env">
          <input className="input" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="deploy, release" />
        </FormField>
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

/* ------------------------------------------------------------------ record event (deployment marker etc.) */

export function EventForm({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const { projects, writeProjectId } = useProjectScope();
  const [projectId, setProjectId] = useState('');
  const [type, setType] = useState<string>('DEPLOYMENT');
  const [severity, setSeverity] = useState('INFO');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [ts, setTs] = useState('');
  const [runKey, setRunKey] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    if (!open) return;
    setProjectId(writeProjectId ?? ''); setType('DEPLOYMENT'); setSeverity('INFO'); setTitle(''); setDescription('');
    setTs(toLocalInput(Date.now())); setRunKey(null); setTouched(false);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const errors = { title: !title.trim() ? 'Title is required' : null, project: !projectId ? 'Choose a project' : null };
  const invalid = Object.values(errors).some(Boolean);
  const save = useMutation({
    mutationFn: () => api.post<EventRow>('/events', {
      projectId, type, severity, title: title.trim(), description: description.trim() || undefined, ts: ts ? fromLocalInput(ts) : undefined, runId: runKey ?? undefined,
    }),
    onSuccess: () => { toast.success('Event recorded'); invalidate(qc); onClose(); },
    onError: (e) => toast.error(errMsg(e)),
  });
  const submit = () => { setTouched(true); if (!invalid) save.mutate(); };

  return (
    <Modal open={open} onClose={onClose} title="Record event" width={560}
      footer={<>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" onClick={submit} disabled={save.isPending}>{save.isPending ? 'Saving…' : 'Record event'}</button>
      </>}>
      <form className="ev-form" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <div className="ev-form-2">
          <FormField label="Project" required error={touched ? errors.project : null}>
            <select className="select" value={projectId} onChange={(e) => { setProjectId(e.target.value); setRunKey(null); }}>
              <option value="">Select a project…</option>
              {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </FormField>
          <FormField label="Type" required>
            <select className="select" value={type} onChange={(e) => setType(e.target.value)}>
              {EVENT_TYPES.map((t) => <option key={t} value={t}>{typeMeta(t).label}</option>)}
            </select>
          </FormField>
        </div>
        <FormField label="Title" required error={touched ? errors.title : null}>
          <input className="input" value={title} maxLength={300} autoFocus placeholder="e.g. payments-api 2.3.0 deployed" onChange={(e) => setTitle(e.target.value)} />
        </FormField>
        <FormField label="Description">
          <textarea className="textarea" rows={3} value={description} maxLength={5000} onChange={(e) => setDescription(e.target.value)} />
        </FormField>
        <div className="ev-form-2">
          <FormField label="Severity">
            <select className="select" value={severity} onChange={(e) => setSeverity(e.target.value)}>
              <option value="INFO">Info</option><option value="WARNING">Warning</option><option value="CRITICAL">Critical</option>
            </select>
          </FormField>
          <FormField label="When" hint="Defaults to now.">
            <input className="input" type="datetime-local" value={ts} onChange={(e) => setTs(e.target.value)} />
          </FormField>
        </div>
        <FormField label="Linked run" hint="Optional.">
          <RunLink value={runKey} onChange={(k, pid) => { setRunKey(k); if (k && pid) setProjectId(pid); }} />
        </FormField>
        <p className="muted" style={{ margin: 0, fontSize: 11.5 }}>CI pipelines can record the same markers with <span className="mono">POST /api/v1/events</span> and an API key.</p>
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}
