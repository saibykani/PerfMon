-- Observability hub: continuous collection schedules, OBSERVABILITY reports, time-window indexes.

CREATE TABLE IF NOT EXISTS observability_collection (
  integration_id  uuid PRIMARY KEY REFERENCES integrations(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  environment_id  uuid REFERENCES environments(id) ON DELETE SET NULL,
  enabled         boolean NOT NULL DEFAULT true,
  interval_sec    int NOT NULL DEFAULT 60 CHECK (interval_sec >= 60 AND interval_sec <= 86400),
  last_run_at     timestamptz,
  last_status     text,               -- RUNNING | OK | NO_DATA | ERROR | DISABLED
  last_error      text,
  points          int NOT NULL DEFAULT 0,      -- points stored by the last run
  total_points    bigint NOT NULL DEFAULT 0,
  watermark       timestamptz,        -- end (exclusive) of the last imported window: next window starts here (no overlap)
  created_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS observability_collection_org_idx ON observability_collection(organization_id);

-- Report type OBSERVABILITY
ALTER TABLE reports DROP CONSTRAINT IF EXISTS reports_type_check;
ALTER TABLE reports ADD CONSTRAINT reports_type_check CHECK (type IN
  ('TEST_EXECUTION','EXECUTIVE','ENGINEERING','REGRESSION','SLA','CAPACITY','INFRASTRUCTURE','TREND','COMPARISON','OBSERVABILITY'));

-- Time-window scans across all entities of an organization (no entity filter): ts-leading indexes.
CREATE INDEX IF NOT EXISTS server_metrics_ts_idx ON server_metrics(ts);
CREATE INDEX IF NOT EXISTS database_metrics_ts_idx ON database_metrics(ts);
CREATE INDEX IF NOT EXISTS jvm_metrics_ts_idx ON jvm_metrics(ts);
CREATE INDEX IF NOT EXISTS jvm_metrics_server_ts_idx ON jvm_metrics(server_id, ts);
CREATE INDEX IF NOT EXISTS service_metrics_ts_idx ON service_metrics(ts);
-- Kubernetes samples: metric + time for one source
CREATE INDEX IF NOT EXISTS metric_points_k8s_metric_ts_idx ON metric_points(metric, ts) WHERE source = 'kubernetes';
