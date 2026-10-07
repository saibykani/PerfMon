import { ArrowLeftRight } from 'lucide-react';
import { PageHeader } from '@/components/ui';
import { EmptyState, SkeletonGrid } from '@/components/run/common';
import { RunSelectorBar, useRunSelection } from '@/components/run/RunPicker';
import { TransactionsView } from '@/components/run/TxnViews';
import '@/styles/run.css';

/** Cross-run transaction analysis: pick project/test/run (defaults to the latest completed run). */
export function TransactionsPage() {
  const sel = useRunSelection();
  return (
    <div>
      <PageHeader title="Transactions" subtitle="JMeter sampler / transaction statistics per run — click a transaction for trends, codes, latency distribution and history across runs." />
      <RunSelectorBar sel={sel} />
      {sel.loading ? <SkeletonGrid count={4} height={200} /> : sel.runId ? <TransactionsView key={sel.runId} runId={sel.runId} layout="side" /> : (
        <EmptyState icon={<ArrowLeftRight size={26} />} title="No completed runs match the filters">Change the project / test filters, or pick a run explicitly. Transactions appear once a run has metrics.</EmptyState>
      )}
    </div>
  );
}
