const STATUS_CLASS: Record<string, string> = {
  RUNNING: 'info', COMPLETED: 'pass', FAILED: 'fail', ABORTED: 'warn', CANCELLED: '', ANALYZING: 'accent', QUEUED: '', SCHEDULED: '',
  PASS: 'pass', PASS_WITH_WARNINGS: 'warn', FAIL: 'fail', INCONCLUSIVE: '', WARNING: 'warn', CRITICAL: 'fail', HEALTHY: 'pass', UNKNOWN: '', INFO: 'info', NO_DATA: '', 'N/A': '',
  FIRING: 'fail', ACKNOWLEDGED: 'warn', RESOLVED: 'pass', PROCESSING: 'info', PENDING: '', SKIPPED: '',
};

export function StatusBadge({ value, title }: { value?: string | null; title?: string }) {
  if (!value) return <span className="muted">—</span>;
  return (
    <span className={`badge ${STATUS_CLASS[value] ?? ''}`} title={title}>
      {value === 'RUNNING' && <span className="dot live-dot" />}
      {value.replace(/_/g, ' ')}
    </span>
  );
}
