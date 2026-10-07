import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronDown, ChevronRight, ExternalLink, Wrench } from 'lucide-react';
import { fmtDate } from '@/components/format';
import { ConfidenceLabel, PriorityChip, SeverityBadge } from '@/components/analysis/shared';

/* ------------------------------------------------------------------ API shape (GET /insights) */

export interface Recommendation { title: string; description: string; priority: 'HIGH' | 'MEDIUM' | 'LOW' | string }
export interface Insight {
  id: string; runId: string; runKey: string; testName: string; category: string; severity: 'INFO' | 'WARNING' | 'CRITICAL'; title: string; description: string;
  evidence: string[]; confidence: number | null; confidenceLabel: string | null; component: string | null; createdAt: string; recommendations: Recommendation[];
}

export const CATEGORY_LABEL: Record<string, string> = {
  BOTTLENECK: 'Bottleneck', LATENCY: 'Latency', THROUGHPUT: 'Throughput', ERRORS: 'Errors', INFRASTRUCTURE: 'Infrastructure', JVM: 'JVM', DATABASE: 'Database',
  REGRESSION: 'Regression', IMPROVEMENT: 'Improvement', DATA_QUALITY: 'Data quality', SLA: 'SLA',
};
export const categoryLabel = (c: string) => CATEGORY_LABEL[c] ?? c.charAt(0) + c.slice(1).toLowerCase().replace(/_/g, ' ');

/** What the insight points at: an infrastructure component, or a transaction named in the title. */
export function affectedOf(i: Pick<Insight, 'component' | 'title'>): { kind: 'Component' | 'Transaction'; name: string } | null {
  if (i.component) return { kind: 'Component', name: i.component };
  const m = /^Slowest transaction:\s*(.+)$/i.exec(i.title);
  return m ? { kind: 'Transaction', name: m[1].trim() } : null;
}

/** Title with numbers masked, so the same finding across runs groups together ("P95 increased by #%"). */
export const patternOf = (title: string) => title.replace(/(?<![A-Za-z0-9/_.-])\d+(?:[.,]\d+)?/g, '#').replace(/\s+/g, ' ').trim();

export function InsightCard({ insight: i, showRun = true, onAffected }: { insight: Insight; showRun?: boolean; onAffected?: (name: string) => void }) {
  const [open, setOpen] = useState(i.severity !== 'INFO');
  const affected = affectedOf(i);
  const recs = i.recommendations ?? [];
  const evidence = i.evidence ?? [];
  const hasMore = evidence.length > 0 || recs.length > 0;
  return (
    <article className={`an-card sev-${i.severity} in-card ${i.category === 'IMPROVEMENT' ? 'imp' : ''}`}>
      <div className="an-card-head">
        <SeverityBadge value={i.severity} />
        <span className="an-card-title">{i.title}</span>
        {(i.confidenceLabel || i.confidence != null) && <ConfidenceLabel label={i.confidenceLabel} confidence={i.confidence} />}
        <span className="in-cat">{categoryLabel(i.category)}</span>
      </div>
      <div className="in-desc">{i.description}</div>
      <div className="an-card-meta">
        {showRun && <span>Run <Link className="mono" to={`/runs/${i.runKey}`}><b>{i.runKey}</b></Link></span>}
        {showRun && <span className="sep">·</span>}
        <span>{i.testName}</span>
        {affected && <>
          <span className="sep">·</span>
          <span>{affected.kind}{' '}
            {onAffected ? <button type="button" className="in-link" onClick={() => onAffected(affected.name)} title={`Show insights mentioning ${affected.name}`}><b>{affected.name}</b></button> : <b>{affected.name}</b>}
          </span>
        </>}
        <span className="sep">·</span>
        <span className="muted">{fmtDate(i.createdAt)}</span>
        <div className="spacer" />
        {hasMore && (
          <button type="button" className="btn btn-ghost btn-sm" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
            {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
            {[evidence.length && `${evidence.length} evidence`, recs.length && `${recs.length} recommendation${recs.length > 1 ? 's' : ''}`].filter(Boolean).join(' · ')}
          </button>
        )}
        <Link className="btn btn-sm" to={`/runs/${i.runKey}`}><ExternalLink size={12} />Open run</Link>
      </div>
      {open && evidence.length > 0 && (
        <ul className="an-evidence" aria-label="Evidence">{evidence.map((e, k) => <li key={k}>{typeof e === 'string' ? e : JSON.stringify(e)}</li>)}</ul>
      )}
      {open && recs.length > 0 && (
        <div className="an-recs" aria-label="Recommendations">
          {recs.map((r, k) => (
            <div key={k} className="an-rec">
              <Wrench size={13} className="muted" aria-hidden style={{ marginTop: 2 }} />
              <div className="row wrap" style={{ gap: 6 }}><span className="an-rec-title">{r.title}</span><PriorityChip value={r.priority} /></div>
              <div className="an-rec-desc">{r.description}</div>
            </div>
          ))}
        </div>
      )}
      {open && i.confidence != null && <div className="in-foot muted">Correlation is evidence, not proof of root cause — confirm with the run's infrastructure and transaction views.</div>}
    </article>
  );
}
