import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { BookOpen, Lock } from 'lucide-react';
import { Card } from '@/components/ui';
import { CodeBlock, Notice } from '@/components/inventory/common';
import { perfmonOrigin } from '@/components/inventory/NewRun';

const DB_PAYLOAD = `{
  "project": "<project key>",
  "environment": "Performance",
  "service": { "name": "payments-db", "kind": "database", "technology": "PostgreSQL 16" },
  "database": [
    { "ts": "2026-10-06T10:15:00Z", "engine": "postgresql", "connections": 64,
      "activeConnections": 41, "maxConnections": 100, "queryLatencyMs": 7.8,
      "slowQueries": 2, "locks": 3, "deadlocks": 0, "cpuPct": 48.5,
      "memoryPct": 62.0, "transactionsPerSec": 910 }
  ]
}`;

const JVM_PAYLOAD = `{
  "project": "<project key>",
  "environment": "Performance",
  "server": { "name": "app-01", "role": "app" },
  "service": { "name": "payment-service", "kind": "service", "technology": "Java 21 / Spring Boot" },
  "jvm": [
    { "ts": 1791273600000, "heapUsedMb": 1830, "heapCommittedMb": 3072, "heapMaxMb": 4096,
      "nonHeapUsedMb": 210, "gcCount": 3, "gcTimeMs": 41, "gcMaxPauseMs": 18,
      "threadCount": 212, "peakThreads": 230, "classesLoaded": 18450 }
  ],
  "serviceMetrics": [
    { "ts": 1791273600000, "requestRate": 182.5, "errorRatePct": 0.4, "avgLatencyMs": 41,
      "p95LatencyMs": 120, "exceptions": 2, "cpuPct": 55.2, "memoryPct": 61.0 }
  ]
}`;

/**
 * How to get database / JVM metrics into Perfmon (docs 19-database-monitoring, 18-jvm-monitoring, 00d-server-monitoring).
 * Perfmon never connects to your systems: metrics are pushed to the ingestion API with a scoped API key.
 */
export function IngestGuide({ kind, title, intro }: { kind: 'database' | 'jvm'; title?: ReactNode; intro?: ReactNode }) {
  const curl = `curl -s -X POST "${perfmonOrigin()}/api/v1/ingest/infrastructure" \\
  -H "Authorization: Bearer $PERFMON_API_KEY" -H "Content-Type: application/json" \\
  -d @${kind === 'database' ? 'db' : 'jvm'}-metrics.json`;
  return (
    <Card title={title ?? (kind === 'database' ? 'Sending database metrics' : 'Sending JVM & service metrics')}
      actions={<Link className="btn btn-sm" to={kind === 'database' ? '/help/database-monitoring' : '/help/jvm-monitoring'}><BookOpen size={13} />Guide</Link>}>
      <div className="stack">
        <div className="muted small">
          {intro ?? (kind === 'database'
            ? <>Push samples to <span className="mono">POST /api/v1/ingest/infrastructure</span> in the <span className="mono">database</span> array, identified by a service of kind <span className="mono">database</span> (registered automatically). Send <span className="mono">maxConnections</span> so pool utilisation can be computed. Add <span className="mono">"runId"</span> to target a specific run; otherwise samples are linked to the environment’s running test.</>
            : <>The Perfmon Collector only sends host metrics. Push JVM samples from a small JMX/Micrometer exporter (or an integration) to <span className="mono">POST /api/v1/ingest/infrastructure</span> in the <span className="mono">jvm</span> array, and per-service request rate, errors, latency and CPU in <span className="mono">serviceMetrics</span>. <b>Always send <span className="mono">heapMaxMb</span></b> — heap % SLAs and alerts depend on it.</>)}
        </div>
        <CodeBlock label={kind === 'database' ? 'db-metrics.json' : 'jvm-metrics.json'} code={kind === 'database' ? DB_PAYLOAD : JVM_PAYLOAD} />
        <CodeBlock label="Send" code={curl} />
        <div className="muted small">
          Alternatives: {kind === 'database' ? <>Prometheus exporters (<span className="mono">postgres_exporter</span>, <span className="mono">mysqld_exporter</span>)</> : <>Prometheus (Micrometer / JMX exporter), OpenTelemetry</>} or Dynatrace via <Link to="/integrations">Integrations</Link>.
          Host CPU / memory come from the Perfmon Collector — see <Link to="/help/server-monitoring">Server monitoring</Link>.
        </div>
        <Notice kind="warn" icon={<Lock size={15} />}>Use an API key with the <span className="mono">ingest</span> scope (Admin → API keys). No database or JVM credentials are stored in Perfmon.</Notice>
      </div>
    </Card>
  );
}
