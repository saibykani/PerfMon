import { Network } from 'lucide-react';
import { PageHeader } from '@/components/ui';
import { EmptyState, SkeletonGrid } from '@/components/run/common';
import { RunSelectorBar, useRunSelection } from '@/components/run/RunPicker';
import { EndpointsView } from '@/components/run/TxnViews';
import '@/styles/run.css';

/** Normalized API endpoints (method + templated path) for a run. */
export function ApisPage() {
  const sel = useRunSelection();
  return (
    <div>
      <PageHeader title="APIs" subtitle="Normalized endpoints (IDs templated) with throughput, latency percentiles, errors and status codes — click one to drill down." />
      <RunSelectorBar sel={sel} />
      {sel.loading ? <SkeletonGrid count={4} height={200} /> : sel.runId ? <EndpointsView key={sel.runId} runId={sel.runId} layout="side" /> : (
        <EmptyState icon={<Network size={26} />} title="No completed runs match the filters">Change the project / test filters, or pick a run explicitly.</EmptyState>
      )}
    </div>
  );
}
