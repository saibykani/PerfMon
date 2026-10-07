/**
 * Pluggable integration connectors.
 *
 * A connector knows how to (1) test a connection and (2) optionally pull metrics for a
 * run's time window from an external system, returning them as generic series. The
 * series are stored by `store.ts` in Perfmon's own metric model (server/jvm/database/
 * service tables or generic metric_points), always correlated to the Run ID. The UI
 * never sees PromQL/Flux/metric selectors: it works with Perfmon metric names and
 * configurable mappings (integration.config.mappings).
 *
 * To add a connector: implement `Connector`, then register it in `connectors/index.ts`
 * (and add the type to the integrations.type CHECK constraint).
 */

export type ImportTarget = 'server' | 'jvm' | 'database' | 'service' | 'custom';

export interface IntegrationRecord {
  id: string;
  organizationId: string;
  projectId: string | null;
  name: string;
  type: string;
  url: string | null;
  authType: 'NONE' | 'TOKEN' | 'BASIC' | 'API_KEY';
  config: Record<string, any>;
}

/** Decrypted credentials by name (token, username, password, apiToken, ...). Never logged or returned. */
export type Credentials = Record<string, string>;

/**
 * One metric to import. `query` is source-specific:
 *  - Prometheus: PromQL expression
 *  - InfluxDB:   structured "measurement:field" or "measurement:field{tag=value,...}" (Perfmon generates Flux/InfluxQL),
 *                or a raw Flux / InfluxQL statement for advanced users
 *  - Dynatrace:  metric selector (e.g. builtin:host.cpu.usage:names)
 */
export interface ImportQuery {
  metric: string;                 // Perfmon metric (cpu_pct, heap_used_mb, query_latency_ms, request_rate...) or any name for custom
  query: string;
  target: ImportTarget;
  serverName?: string;            // fixed server name (otherwise derived from host/instance labels)
  serviceName?: string;
  scale?: number;                 // multiply values (unit conversion, e.g. bytes → MB = 1/1048576)
  transform?: 'invert_pct';       // 100 - value (e.g. CPU idle → CPU used)
  role?: string;                  // server role when auto-registering (app, db, loadgen...)
}

export interface RunWindow {
  id: string;
  runKey: string;
  projectId: string;
  applicationId: string;
  environmentId: string;
  from: Date;
  to: Date;
  stepSec: number;
}

export interface ImportedSeries {
  query: ImportQuery;
  labels: Record<string, string>;
  points: [number, number][];     // [epoch ms, value]
}

export interface TestResult {
  ok: boolean;
  latencyMs: number;
  message: string;
  details?: unknown;
}

export interface FieldDef { key: string; label: string; required: boolean; secret?: boolean; placeholder?: string; help?: string }

export interface Connector {
  type: string;
  label: string;
  category: 'LOAD_TESTING' | 'METRICS' | 'APM' | 'OBSERVABILITY' | 'CI_CD' | 'DASHBOARDS';
  authTypes: IntegrationRecord['authType'][];
  /** Non-secret config + credential fields rendered by the UI. Secret fields go to integration_credentials. */
  fields: FieldDef[];
  supportsImport: boolean;
  docs: string;
  defaultQueries?: (integration: IntegrationRecord) => ImportQuery[];
  test(integration: IntegrationRecord, creds: Credentials): Promise<TestResult>;
  importRun?(integration: IntegrationRecord, creds: Credentials, run: RunWindow, queries: ImportQuery[]): Promise<{ series: ImportedSeries[]; warnings: string[] }>;
}
