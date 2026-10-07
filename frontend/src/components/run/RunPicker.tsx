
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '@/services/api';
import { useFilters } from '@/stores/filters';
import { GlobalFilterBar } from '@/components/GlobalFilters';
import { StatusChip } from './common';
import { fmtDate } from '@/components/format';

interface RunLite { id: string; runId: string; testName: string; status: string; result: string | null; buildNumber: string | null; startedAt: string | null; environmentName: string; kpis?: { percentileMethod: string | null } }

/**
 * Filter bar + run selector for cross-run pages. Defaults to the latest COMPLETED run matching the
 * global filters (project / application / environment / test). Returns the effective Run ID.
 */
export function useRunSelection() {
  const f = useFilters();
  const latest = useQuery({
    queryKey: ['latest-run', f.projectId, f.applicationId, f.environmentId, f.testId],
    queryFn: () => api.get<{ items: RunLite[] }>('/runs', { projectId: f.projectId, applicationId: f.applicationId, environmentId: f.environmentId, testId: f.testId, status: 'COMPLETED', pageSize: 1, sort: 'start', order: 'desc' }),
  });
  const effective = f.runId ?? latest.data?.items[0]?.runId ?? null;
  const run = useQuery({ queryKey: ['run-lite', effective], queryFn: () => api.get<RunLite & { summary: { percentileMethod: string | null } | null }>(`/runs/${encodeURIComponent(effective!)}`), enabled: !!effective });
  return { runId: effective, auto: !f.runId && !!effective, loading: latest.isLoading, run: run.data };
}

export function RunSelectorBar({ sel }: { sel: ReturnType<typeof useRunSelection> }) {
  const set = useFilters((s) => s.set);
  return (
    <>
      <GlobalFilterBar show={['project', 'application', 'environment', 'test', 'run']} />
      {sel.run && (
        <div className="run-context">
          <span className="muted small">{sel.auto ? 'Latest completed run' : 'Selected run'}</span>
          <Link className="mono" to={`/runs/${sel.run.runId}`}>{sel.run.runId}</Link>
          <b>{sel.run.testName}</b>
          <span className="muted small">{sel.run.environmentName} · build {sel.run.buildNumber ?? '—'} · {fmtDate(sel.run.startedAt)}</span>
          {sel.run.result && <StatusChip status={sel.run.result} size="sm" label={sel.run.result.replace(/_/g, ' ')} />}
          {!sel.auto && <button className="btn btn-ghost btn-sm" onClick={() => set({ runId: null })}>Use latest</button>}
        </div>
      )}
    </>
  );
}
