-- =====================================================================
-- Perfmon core schema
-- Hierarchy: organization -> project -> application -> environment
--            -> performance_test -> test_run (Run ID) -> metrics/artifacts/analysis
-- Every metric row references a test_run (run_id). The run row carries the
-- full lineage (organization/project/application/environment/test), so
-- every data point is traceable back to its execution.
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ---------------------------------------------------------------------
-- Identity & access
-- ---------------------------------------------------------------------
CREATE TABLE organizations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  slug        text NOT NULL UNIQUE,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id           uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email                     text NOT NULL UNIQUE,
  name                      text NOT NULL,
  password_hash             text NOT NULL,
  is_active                 boolean NOT NULL DEFAULT true,
  preferred_view            text NOT NULL DEFAULT 'PERFORMANCE_ENGINEER',
  password_reset_token_hash text,
  password_reset_expires_at timestamptz,
  failed_login_count        int NOT NULL DEFAULT 0,
  locked_until              timestamptz,
  last_login_at             timestamptz,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE roles (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL UNIQUE,
  description text,
  is_system   boolean NOT NULL DEFAULT true
);

CREATE TABLE permissions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code        text NOT NULL UNIQUE,
  description text
);

CREATE TABLE role_permissions (
  role_id       uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_id uuid NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_id)
);

CREATE TABLE user_roles (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, role_id)
);

CREATE TABLE api_keys (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id         uuid,
  name               text NOT NULL,
  prefix             text NOT NULL UNIQUE,      -- shown to users, e.g. pmk_ab12cd34
  key_hash           text NOT NULL,             -- sha256 of the full secret
  scopes             text[] NOT NULL DEFAULT ARRAY['ingest'],
  rate_limit_per_sec int,
  created_by         uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  expires_at         timestamptz,
  revoked_at         timestamptz,
  last_used_at       timestamptz,
  rotated_from_id    uuid REFERENCES api_keys(id) ON DELETE SET NULL
);

-- ---------------------------------------------------------------------
-- Inventory hierarchy
-- ---------------------------------------------------------------------
CREATE TABLE projects (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  key             text NOT NULL,
  name            text NOT NULL,
  description     text,
  created_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  archived_at     timestamptz,
  UNIQUE (organization_id, key)
);
ALTER TABLE api_keys ADD CONSTRAINT api_keys_project_fk FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;

CREATE TABLE applications (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  code        text NOT NULL,                    -- "Application ID"
  name        text NOT NULL,
  description text,
  owner       text,
  team        text,
  technology  text,
  repository  text,
  version     text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  UNIQUE (project_id, code)
);
CREATE INDEX applications_project_idx ON applications(project_id);

CREATE TABLE environments (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id     uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  application_id uuid NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  name           text NOT NULL,
  type           text NOT NULL CHECK (type IN ('DEV','QA','SIT','UAT','PERFORMANCE','STAGING','PRODUCTION')),
  description    text,
  base_url       text,
  config         jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (application_id, name)
);
CREATE INDEX environments_project_idx ON environments(project_id);
CREATE INDEX environments_application_idx ON environments(application_id);

CREATE TABLE servers (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id     uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  environment_id uuid REFERENCES environments(id) ON DELETE SET NULL,
  application_id uuid REFERENCES applications(id) ON DELETE SET NULL,
  name           text NOT NULL,
  hostname       text,
  ip_address     text,
  os             text,
  cpu_cores      int,
  memory_mb      int,
  disk_gb        int,
  role           text,                -- app, db, loadgen, gateway, cache...
  status         text NOT NULL DEFAULT 'UNKNOWN' CHECK (status IN ('HEALTHY','WARNING','CRITICAL','UNKNOWN')),
  tags           jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_seen_at   timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, name)
);
CREATE INDEX servers_env_idx ON servers(environment_id);

CREATE TABLE services (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id     uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  application_id uuid REFERENCES applications(id) ON DELETE SET NULL,
  environment_id uuid REFERENCES environments(id) ON DELETE SET NULL,
  server_id      uuid REFERENCES servers(id) ON DELETE SET NULL,
  name           text NOT NULL,
  kind           text NOT NULL DEFAULT 'service' CHECK (kind IN ('loadgen','gateway','service','database','cache','queue','external')),
  technology     text,
  health_status  text NOT NULL DEFAULT 'UNKNOWN' CHECK (health_status IN ('HEALTHY','WARNING','CRITICAL','UNKNOWN')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, environment_id, name)
);

CREATE TABLE service_dependencies (
  source_service_id uuid NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  target_service_id uuid NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  protocol          text,
  PRIMARY KEY (source_service_id, target_service_id)
);

-- ---------------------------------------------------------------------
-- SLA / SLO
-- ---------------------------------------------------------------------
CREATE TABLE sla_profiles (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name        text NOT NULL,
  description text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, name)
);

-- direction LOWER: good < warning <= warn < critical <= fail
-- direction HIGHER: good >= warning > warn >= critical > fail
-- Either threshold may be NULL. Only critical => hard pass/fail threshold.
CREATE TABLE sla_rules (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id          uuid NOT NULL REFERENCES sla_profiles(id) ON DELETE CASCADE,
  name                text,
  metric              text NOT NULL,     -- avg_rt, p50, p90, p95, p99, max_rt, error_pct, tps, cpu_pct, memory_pct, heap_pct, gc_pause_ms, db_latency_ms
  scope               text NOT NULL DEFAULT 'RUN' CHECK (scope IN ('RUN','TRANSACTION')),
  transaction_pattern text,              -- glob, NULL = each transaction (TRANSACTION scope)
  direction           text NOT NULL DEFAULT 'LOWER' CHECK (direction IN ('LOWER','HIGHER')),
  warning_value       double precision,
  critical_value      double precision,
  unit                text,
  enabled             boolean NOT NULL DEFAULT true,
  position            int NOT NULL DEFAULT 0,
  CHECK (warning_value IS NOT NULL OR critical_value IS NOT NULL)
);
CREATE INDEX sla_rules_profile_idx ON sla_rules(profile_id);

-- ---------------------------------------------------------------------
-- Tests, releases, builds, runs
-- ---------------------------------------------------------------------
CREATE TABLE performance_tests (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  application_id  uuid NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  environment_id  uuid NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
  name            text NOT NULL,
  description     text,
  test_type       text NOT NULL DEFAULT 'LOAD' CHECK (test_type IN ('LOAD','STRESS','SPIKE','SOAK','ENDURANCE','VOLUME','CAPACITY','SCALABILITY','BASELINE')),
  sla_profile_id  uuid REFERENCES sla_profiles(id) ON DELETE SET NULL,
  owner           text,
  tags            text[] NOT NULL DEFAULT '{}',
  baseline_run_id uuid,
  created_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  archived_at     timestamptz,
  UNIQUE (environment_id, name)
);
CREATE INDEX performance_tests_project_idx ON performance_tests(project_id);
CREATE INDEX performance_tests_app_idx ON performance_tests(application_id);

CREATE TABLE test_configurations (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  test_id          uuid NOT NULL REFERENCES performance_tests(id) ON DELETE CASCADE,
  version          int NOT NULL,
  virtual_users    int,
  ramp_up_sec      int,
  ramp_down_sec    int,
  duration_sec     int,
  target_tps       double precision,
  thread_group     text,
  think_time_ms    int,
  jmx_artifact_id  uuid,
  properties       jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_current       boolean NOT NULL DEFAULT true,
  created_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (test_id, version)
);

-- Test metadata / data. Sensitive values are encrypted and never returned in clear.
CREATE TABLE test_data (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  test_id       uuid NOT NULL REFERENCES performance_tests(id) ON DELETE CASCADE,
  key           text NOT NULL,
  value         text,
  is_sensitive  boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (test_id, key)
);

CREATE TABLE releases (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  application_id  uuid REFERENCES applications(id) ON DELETE SET NULL,
  environment_id  uuid REFERENCES environments(id) ON DELETE SET NULL,
  name            text NOT NULL,
  version         text NOT NULL,
  build_number    text,
  branch          text,
  commit_sha      text,
  deployment_date timestamptz,
  notes           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, version)
);

CREATE TABLE builds (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id     uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  application_id uuid REFERENCES applications(id) ON DELETE SET NULL,
  release_id     uuid REFERENCES releases(id) ON DELETE SET NULL,
  build_number   text NOT NULL,
  branch         text,
  commit_sha     text,
  ci_system      text,
  ci_url         text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, build_number)
);

CREATE SEQUENCE run_number_seq START 100;

CREATE TABLE test_runs (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_key               text NOT NULL UNIQUE,     -- user-friendly Run ID e.g. PF-2026-10-06-000127
  execution_id          text,                      -- external execution id (CI job, load generator session)
  organization_id       uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id            uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  application_id        uuid NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  environment_id        uuid NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
  test_id               uuid NOT NULL REFERENCES performance_tests(id) ON DELETE CASCADE,
  test_configuration_id uuid REFERENCES test_configurations(id) ON DELETE SET NULL,
  release_id            uuid REFERENCES releases(id) ON DELETE SET NULL,
  build_id              uuid REFERENCES builds(id) ON DELETE SET NULL,
  build_number          text,
  version               text,
  branch                text,
  commit_sha            text,
  status                text NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('SCHEDULED','QUEUED','RUNNING','COMPLETED','FAILED','ABORTED','CANCELLED','ANALYZING')),
  result                text CHECK (result IN ('PASS','PASS_WITH_WARNINGS','FAIL','INCONCLUSIVE')),
  result_reason         text,
  tester                text,
  triggered_by          text NOT NULL DEFAULT 'MANUAL' CHECK (triggered_by IN ('MANUAL','CI','API','SCHEDULE')),
  ci_system             text,
  ci_url                text,
  load_engine           text NOT NULL DEFAULT 'JMETER',
  tags                  text[] NOT NULL DEFAULT '{}',
  virtual_users         int,
  target_tps            double precision,
  description           text,
  scheduled_at          timestamptz,
  started_at            timestamptz,
  ended_at              timestamptz,
  baseline_run_id       uuid REFERENCES test_runs(id) ON DELETE SET NULL,  -- run this execution was compared against
  is_baseline           boolean NOT NULL DEFAULT false,
  performance_score     double precision,
  live_last_ingest_at   timestamptz,
  created_by            uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  deleted_at            timestamptz
);
CREATE INDEX test_runs_project_idx ON test_runs(project_id, created_at DESC);
CREATE INDEX test_runs_app_idx ON test_runs(application_id);
CREATE INDEX test_runs_env_idx ON test_runs(environment_id);
CREATE INDEX test_runs_test_idx ON test_runs(test_id, started_at DESC);
CREATE INDEX test_runs_status_idx ON test_runs(status);
CREATE INDEX test_runs_started_idx ON test_runs(started_at DESC);
CREATE INDEX test_runs_build_idx ON test_runs(build_number);
CREATE INDEX test_runs_key_trgm ON test_runs USING gin (run_key gin_trgm_ops);
CREATE INDEX test_runs_tags_idx ON test_runs USING gin (tags);
ALTER TABLE performance_tests ADD CONSTRAINT performance_tests_baseline_fk FOREIGN KEY (baseline_run_id) REFERENCES test_runs(id) ON DELETE SET NULL;

-- ---------------------------------------------------------------------
-- Time-series: load test metrics (narrow aggregated buckets)
-- Percentiles are stored per bucket as reported by the source. When the
-- raw samples are available Perfmon also stores a log-bucketed latency
-- histogram so percentiles can be merged accurately across buckets.
-- ---------------------------------------------------------------------
CREATE TABLE run_metrics (
  run_id            uuid NOT NULL REFERENCES test_runs(id) ON DELETE CASCADE,
  ts                timestamptz NOT NULL,
  interval_sec      int NOT NULL DEFAULT 1,
  active_threads    int,
  started_threads   int,
  finished_threads  int,
  sample_count      int NOT NULL DEFAULT 0,
  error_count       int NOT NULL DEFAULT 0,
  sum_rt            double precision NOT NULL DEFAULT 0,
  sum_sq_rt         double precision,
  min_rt            double precision,
  max_rt            double precision,
  p50               double precision,
  p75               double precision,
  p90               double precision,
  p95               double precision,
  p99               double precision,
  p999              double precision,
  bytes_sent        bigint NOT NULL DEFAULT 0,
  bytes_received    bigint NOT NULL DEFAULT 0,
  histogram         int[],
  source            text NOT NULL DEFAULT 'live',
  PRIMARY KEY (run_id, ts, source)
);
CREATE INDEX run_metrics_ts_idx ON run_metrics(ts);

CREATE TABLE api_endpoints (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id uuid NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  method         text NOT NULL,
  path_template  text NOT NULL,
  first_seen_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (application_id, method, path_template)
);

CREATE TABLE transaction_metrics (
  run_id          uuid NOT NULL REFERENCES test_runs(id) ON DELETE CASCADE,
  ts              timestamptz NOT NULL,
  interval_sec    int NOT NULL DEFAULT 1,
  transaction     text NOT NULL,
  sample_count    int NOT NULL DEFAULT 0,
  error_count     int NOT NULL DEFAULT 0,
  sum_rt          double precision NOT NULL DEFAULT 0,
  sum_sq_rt       double precision,
  min_rt          double precision,
  max_rt          double precision,
  p50             double precision,
  p75             double precision,
  p90             double precision,
  p95             double precision,
  p99             double precision,
  p999            double precision,
  bytes_sent      bigint NOT NULL DEFAULT 0,
  bytes_received  bigint NOT NULL DEFAULT 0,
  sum_latency     double precision,
  sum_connect     double precision,
  histogram       int[],
  source          text NOT NULL DEFAULT 'live',
  PRIMARY KEY (run_id, transaction, ts, source)
);
CREATE INDEX transaction_metrics_run_ts_idx ON transaction_metrics(run_id, ts);
CREATE INDEX transaction_metrics_txn_idx ON transaction_metrics(transaction);

CREATE TABLE api_metrics (
  run_id         uuid NOT NULL REFERENCES test_runs(id) ON DELETE CASCADE,
  endpoint_id    uuid NOT NULL REFERENCES api_endpoints(id) ON DELETE CASCADE,
  ts             timestamptz NOT NULL,
  interval_sec   int NOT NULL DEFAULT 1,
  sample_count   int NOT NULL DEFAULT 0,
  error_count    int NOT NULL DEFAULT 0,
  sum_rt         double precision NOT NULL DEFAULT 0,
  min_rt         double precision,
  max_rt         double precision,
  p95            double precision,
  p99            double precision,
  histogram      int[],
  status_codes   jsonb NOT NULL DEFAULT '{}'::jsonb,
  source         text NOT NULL DEFAULT 'live',
  PRIMARY KEY (run_id, endpoint_id, ts, source)
);
CREATE INDEX api_metrics_endpoint_idx ON api_metrics(endpoint_id);

CREATE TABLE response_code_metrics (
  run_id        uuid NOT NULL REFERENCES test_runs(id) ON DELETE CASCADE,
  ts            timestamptz NOT NULL,
  transaction   text NOT NULL,
  response_code text NOT NULL,
  success       boolean NOT NULL,
  count         int NOT NULL,
  source        text NOT NULL DEFAULT 'live',
  PRIMARY KEY (run_id, transaction, response_code, ts, source)
);

CREATE TABLE error_metrics (
  run_id        uuid NOT NULL REFERENCES test_runs(id) ON DELETE CASCADE,
  ts            timestamptz NOT NULL,
  transaction   text NOT NULL,
  endpoint      text,
  response_code text,
  error_type    text NOT NULL CHECK (error_type IN ('HTTP','ASSERTION','TIMEOUT','CONNECTION','DNS','SSL','EXCEPTION','OTHER')),
  message       text NOT NULL DEFAULT '',
  count         int NOT NULL,
  source        text NOT NULL DEFAULT 'live'
);
CREATE INDEX error_metrics_run_idx ON error_metrics(run_id, ts);

-- ---------------------------------------------------------------------
-- Time-series: infrastructure / JVM / database / generic
-- run_id is set by the ingestion layer (explicitly or by correlating the
-- environment's active run). Infra metrics may exist outside a run.
-- ---------------------------------------------------------------------
CREATE TABLE server_metrics (
  ts               timestamptz NOT NULL,
  server_id        uuid NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  run_id           uuid REFERENCES test_runs(id) ON DELETE SET NULL,
  cpu_pct          double precision,
  memory_pct       double precision,
  memory_used_mb   double precision,
  disk_pct         double precision,
  disk_read_bps    double precision,
  disk_write_bps   double precision,
  net_in_bps       double precision,
  net_out_bps      double precision,
  load_avg_1m      double precision,
  processes        int,
  tcp_connections  int,
  file_descriptors int,
  source           text NOT NULL DEFAULT 'collector'
);
CREATE INDEX server_metrics_server_ts_idx ON server_metrics(server_id, ts);
CREATE INDEX server_metrics_run_idx ON server_metrics(run_id, ts);

CREATE TABLE jvm_metrics (
  ts                timestamptz NOT NULL,
  server_id         uuid REFERENCES servers(id) ON DELETE CASCADE,
  service_id        uuid REFERENCES services(id) ON DELETE CASCADE,
  run_id            uuid REFERENCES test_runs(id) ON DELETE SET NULL,
  heap_used_mb      double precision,
  heap_committed_mb double precision,
  heap_max_mb       double precision,
  nonheap_used_mb   double precision,
  gc_count          int,
  gc_time_ms        double precision,
  gc_max_pause_ms   double precision,
  thread_count      int,
  peak_threads      int,
  classes_loaded    int,
  source            text NOT NULL DEFAULT 'collector'
);
CREATE INDEX jvm_metrics_run_idx ON jvm_metrics(run_id, ts);
CREATE INDEX jvm_metrics_service_idx ON jvm_metrics(service_id, ts);

CREATE TABLE database_metrics (
  ts                  timestamptz NOT NULL,
  service_id          uuid REFERENCES services(id) ON DELETE CASCADE,
  server_id           uuid REFERENCES servers(id) ON DELETE CASCADE,
  run_id              uuid REFERENCES test_runs(id) ON DELETE SET NULL,
  db_engine           text,
  connections         int,
  active_connections  int,
  max_connections     int,
  query_latency_ms    double precision,
  slow_queries        int,
  locks               int,
  deadlocks           int,
  cpu_pct             double precision,
  memory_pct          double precision,
  transactions_per_sec double precision,
  source              text NOT NULL DEFAULT 'collector'
);
CREATE INDEX database_metrics_run_idx ON database_metrics(run_id, ts);
CREATE INDEX database_metrics_service_idx ON database_metrics(service_id, ts);

-- Application/service-level APM series (request rate, latency, errors, dependency latency)
CREATE TABLE service_metrics (
  ts                timestamptz NOT NULL,
  service_id        uuid NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  run_id            uuid REFERENCES test_runs(id) ON DELETE SET NULL,
  request_rate      double precision,
  error_rate_pct    double precision,
  avg_latency_ms    double precision,
  p95_latency_ms    double precision,
  exceptions        int,
  cpu_pct           double precision,
  memory_pct        double precision,
  source            text NOT NULL DEFAULT 'collector'
);
CREATE INDEX service_metrics_service_idx ON service_metrics(service_id, ts);
CREATE INDEX service_metrics_run_idx ON service_metrics(run_id, ts);

-- Generic dimensional metric points (custom metrics, integrations: Prometheus/Influx/Dynatrace/OTel)
CREATE TABLE metric_points (
  ts             timestamptz NOT NULL,
  metric         text NOT NULL,
  value          double precision NOT NULL,
  run_id         uuid REFERENCES test_runs(id) ON DELETE CASCADE,
  project_id     uuid REFERENCES projects(id) ON DELETE CASCADE,
  environment_id uuid REFERENCES environments(id) ON DELETE CASCADE,
  tags           jsonb NOT NULL DEFAULT '{}'::jsonb,
  source         text NOT NULL DEFAULT 'api'
);
CREATE INDEX metric_points_run_metric_idx ON metric_points(run_id, metric, ts);
CREATE INDEX metric_points_metric_ts_idx ON metric_points(metric, ts);
CREATE INDEX metric_points_tags_idx ON metric_points USING gin (tags);

-- ---------------------------------------------------------------------
-- Run summaries (computed by the analytics engine)
-- ---------------------------------------------------------------------
CREATE TABLE run_summary (
  run_id               uuid NOT NULL REFERENCES test_runs(id) ON DELETE CASCADE,
  source               text NOT NULL DEFAULT 'live',   -- live | html_report | jtl
  computed_at          timestamptz NOT NULL DEFAULT now(),
  total_samples        bigint,
  success_count        bigint,
  failure_count        bigint,
  error_pct            double precision,
  tps_avg              double precision,
  tps_peak             double precision,
  avg_rt               double precision,
  min_rt               double precision,
  max_rt               double precision,
  median_rt            double precision,
  p50                  double precision,
  p75                  double precision,
  p90                  double precision,
  p95                  double precision,
  p99                  double precision,
  p999                 double precision,
  stddev_rt            double precision,
  users_avg            double precision,
  users_peak           int,
  bytes_sent           bigint,
  bytes_received       bigint,
  sent_kb_sec          double precision,
  received_kb_sec      double precision,
  duration_sec         double precision,
  percentile_method    text,     -- exact_histogram | interval_weighted_approx | source_reported
  sla_pass_pct         double precision,
  sla_violations       int,
  apdex                double precision,
  extra                jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (run_id, source)
);

-- Per-run transaction summary ("Transactions" table)
CREATE TABLE transactions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id         uuid NOT NULL REFERENCES test_runs(id) ON DELETE CASCADE,
  name           text NOT NULL,
  source         text NOT NULL DEFAULT 'live',
  endpoint_id    uuid REFERENCES api_endpoints(id) ON DELETE SET NULL,
  samples        bigint NOT NULL DEFAULT 0,
  errors         bigint NOT NULL DEFAULT 0,
  error_pct      double precision,
  tps            double precision,
  avg_rt         double precision,
  min_rt         double precision,
  max_rt         double precision,
  median_rt      double precision,
  p75            double precision,
  p90            double precision,
  p95            double precision,
  p99            double precision,
  stddev_rt      double precision,
  received_kb_sec double precision,
  sent_kb_sec    double precision,
  sla_status     text,     -- PASS | WARNING | FAIL | NO_SLA
  percentile_method text,
  UNIQUE (run_id, name, source)
);
CREATE INDEX transactions_name_idx ON transactions(name);

-- ---------------------------------------------------------------------
-- Artifacts & reports (files live in object storage; metadata here)
-- ---------------------------------------------------------------------
CREATE TABLE artifacts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id          uuid NOT NULL REFERENCES test_runs(id) ON DELETE CASCADE,
  project_id      uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  test_id         uuid NOT NULL REFERENCES performance_tests(id) ON DELETE CASCADE,
  kind            text NOT NULL CHECK (kind IN ('HTML_REPORT','JTL','CSV','JMX','LOG','SCREENSHOT','SERVER_LOG','APP_LOG','CONFIG','TEST_DATA','JSON','XML','PDF','EXCEL','ZIP','OTHER')),
  name            text NOT NULL,
  description     text,
  source          text NOT NULL DEFAULT 'UPLOAD' CHECK (source IN ('UPLOAD','CI','API','SYSTEM','COLLECTOR')),
  current_version int NOT NULL DEFAULT 1,
  created_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz,
  UNIQUE (run_id, kind, name)
);
CREATE INDEX artifacts_run_idx ON artifacts(run_id);
CREATE INDEX artifacts_name_trgm ON artifacts USING gin (name gin_trgm_ops);

CREATE TABLE artifact_versions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  artifact_id       uuid NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  version           int NOT NULL,
  storage_key       text NOT NULL,
  extracted_prefix  text,                    -- for HTML reports: where the unzipped site lives
  entry_file        text,                    -- e.g. index.html
  original_filename text NOT NULL,
  mime_type         text,
  size_bytes        bigint NOT NULL,
  sha256            text NOT NULL,
  uploaded_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  uploaded_by_name  text,
  uploaded_at       timestamptz NOT NULL DEFAULT now(),
  processing_status text NOT NULL DEFAULT 'PENDING' CHECK (processing_status IN ('PENDING','QUEUED','PROCESSING','COMPLETED','FAILED','SKIPPED')),
  processing_error  text,
  scan_status       text NOT NULL DEFAULT 'NOT_SCANNED' CHECK (scan_status IN ('NOT_SCANNED','CLEAN','INFECTED','ERROR')),
  metadata          jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (artifact_id, version)
);
CREATE INDEX artifact_versions_sha_idx ON artifact_versions(sha256);

-- Parsed JMeter HTML report statistics (one per artifact version)
CREATE TABLE html_report_summaries (
  artifact_version_id uuid PRIMARY KEY REFERENCES artifact_versions(id) ON DELETE CASCADE,
  run_id              uuid NOT NULL REFERENCES test_runs(id) ON DELETE CASCADE,
  parsed_at           timestamptz NOT NULL DEFAULT now(),
  parser_version      text NOT NULL,
  report_generated_at text,
  overall             jsonb NOT NULL DEFAULT '{}'::jsonb,
  transactions        jsonb NOT NULL DEFAULT '[]'::jsonb,
  errors              jsonb NOT NULL DEFAULT '[]'::jsonb,
  top_errors          jsonb NOT NULL DEFAULT '[]'::jsonb,
  response_codes      jsonb NOT NULL DEFAULT '[]'::jsonb,
  apdex               jsonb,
  warnings            text[] NOT NULL DEFAULT '{}'
);
CREATE INDEX html_report_summaries_run_idx ON html_report_summaries(run_id);

-- Generated reports (executive, engineering, regression, SLA...)
CREATE TABLE reports (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  run_id      uuid REFERENCES test_runs(id) ON DELETE CASCADE,
  type        text NOT NULL CHECK (type IN ('TEST_EXECUTION','EXECUTIVE','ENGINEERING','REGRESSION','SLA','CAPACITY','INFRASTRUCTURE','TREND','COMPARISON')),
  title       text NOT NULL,
  version     int NOT NULL DEFAULT 1,
  status      text NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED','GENERATING','READY','FAILED')),
  params      jsonb NOT NULL DEFAULT '{}'::jsonb,   -- run ids, filters => reproducible
  content     jsonb,                                -- report model; exports render from this
  error       text,
  created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX reports_run_idx ON reports(run_id);
CREATE INDEX reports_project_idx ON reports(project_id, created_at DESC);

-- ---------------------------------------------------------------------
-- Logs / events / annotations
-- ---------------------------------------------------------------------
CREATE TABLE log_entries (
  id             bigserial PRIMARY KEY,
  run_id         uuid REFERENCES test_runs(id) ON DELETE CASCADE,
  ts             timestamptz NOT NULL,
  level          text,
  service        text,
  server         text,
  application_id uuid REFERENCES applications(id) ON DELETE SET NULL,
  environment_id uuid REFERENCES environments(id) ON DELETE SET NULL,
  logger         text,
  message        text NOT NULL,
  artifact_id    uuid REFERENCES artifacts(id) ON DELETE CASCADE
);
CREATE INDEX log_entries_run_ts_idx ON log_entries(run_id, ts);
CREATE INDEX log_entries_msg_trgm ON log_entries USING gin (message gin_trgm_ops);

CREATE TABLE events (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id     uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  application_id uuid REFERENCES applications(id) ON DELETE SET NULL,
  environment_id uuid REFERENCES environments(id) ON DELETE SET NULL,
  run_id         uuid REFERENCES test_runs(id) ON DELETE CASCADE,
  type           text NOT NULL CHECK (type IN ('DEPLOYMENT','TEST_START','TEST_END','ALERT','INCIDENT','CONFIG_CHANGE','APP_RESTART','DB_RESTART','REGRESSION','REPORT','OTHER')),
  severity       text NOT NULL DEFAULT 'INFO' CHECK (severity IN ('INFO','WARNING','CRITICAL')),
  ts             timestamptz NOT NULL DEFAULT now(),
  title          text NOT NULL,
  description    text,
  source         text NOT NULL DEFAULT 'perfmon',
  data           jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX events_project_ts_idx ON events(project_id, ts DESC);
CREATE INDEX events_run_idx ON events(run_id, ts);

CREATE TABLE annotations (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id     uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  run_id         uuid REFERENCES test_runs(id) ON DELETE CASCADE,
  environment_id uuid REFERENCES environments(id) ON DELETE SET NULL,
  dashboard_id   uuid,
  ts             timestamptz NOT NULL,
  ts_end         timestamptz,
  title          text NOT NULL,
  text           text,
  tags           text[] NOT NULL DEFAULT '{}',
  created_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  created_by_name text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  search         tsvector GENERATED ALWAYS AS (to_tsvector('simple'::regconfig, coalesce(title,'') || ' ' || coalesce(text,''))) STORED
);
CREATE INDEX annotations_project_ts_idx ON annotations(project_id, ts);
CREATE INDEX annotations_search_idx ON annotations USING gin (search);
CREATE INDEX annotations_tags_idx ON annotations USING gin (tags);

-- ---------------------------------------------------------------------
-- Dashboards
-- ---------------------------------------------------------------------
CREATE TABLE dashboards (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id       uuid REFERENCES projects(id) ON DELETE CASCADE,
  uid              text NOT NULL UNIQUE,
  name             text NOT NULL,
  description      text,
  tags             text[] NOT NULL DEFAULT '{}',
  is_system        boolean NOT NULL DEFAULT false,
  is_shared        boolean NOT NULL DEFAULT true,
  time_range       jsonb NOT NULL DEFAULT '{"type":"relative","value":"24h"}'::jsonb,
  refresh_interval int,      -- seconds, NULL = off
  owner_id         uuid REFERENCES users(id) ON DELETE SET NULL,
  version          int NOT NULL DEFAULT 1,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE dashboard_panels (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dashboard_id  uuid NOT NULL REFERENCES dashboards(id) ON DELETE CASCADE,
  title         text NOT NULL,
  type          text NOT NULL,     -- kpi, line, area, bar, stacked_bar, histogram, heatmap, scatter, gauge, donut, table, stat, timeline, percentiles, tps, error_distribution, sla_gauge, users, latency_heatmap, endpoint_ranking, transaction_ranking, bottleneck, text
  query         jsonb NOT NULL DEFAULT '{}'::jsonb,   -- metric-abstraction query (not PromQL/Flux)
  options       jsonb NOT NULL DEFAULT '{}'::jsonb,
  grid_x        int NOT NULL DEFAULT 0,
  grid_y        int NOT NULL DEFAULT 0,
  grid_w        int NOT NULL DEFAULT 6,
  grid_h        int NOT NULL DEFAULT 4,
  position      int NOT NULL DEFAULT 0
);
CREATE INDEX dashboard_panels_dash_idx ON dashboard_panels(dashboard_id);

CREATE TABLE dashboard_variables (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dashboard_id   uuid NOT NULL REFERENCES dashboards(id) ON DELETE CASCADE,
  name           text NOT NULL,      -- referenced as $name
  label          text,
  type           text NOT NULL CHECK (type IN ('project','application','environment','test','run','transaction','endpoint','server','service','build','custom')),
  custom_values  text[],
  default_value  text,
  multi          boolean NOT NULL DEFAULT false,
  include_all    boolean NOT NULL DEFAULT true,
  position       int NOT NULL DEFAULT 0,
  UNIQUE (dashboard_id, name)
);

-- ---------------------------------------------------------------------
-- Alerting
-- ---------------------------------------------------------------------
CREATE TABLE notification_channels (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name            text NOT NULL,
  type            text NOT NULL CHECK (type IN ('IN_APP','EMAIL','SLACK','TEAMS','WEBHOOK')),
  config          jsonb NOT NULL DEFAULT '{}'::jsonb,      -- non-secret config (recipients etc.)
  secret_ciphertext text,                                  -- AES-256-GCM encrypted webhook URL / token
  enabled         boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE alert_rules (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name          text NOT NULL,
  description   text,
  type          text NOT NULL CHECK (type IN ('HIGH_RESPONSE_TIME','HIGH_P95','HIGH_P99','LOW_TPS','HIGH_ERROR_RATE','CPU','MEMORY','DISK','JVM_HEAP','GC','SLA_VIOLATION','TEST_FAILURE','REGRESSION')),
  metric        text,
  operator      text NOT NULL DEFAULT '>' CHECK (operator IN ('>','>=','<','<=')),
  threshold     double precision,
  severity      text NOT NULL DEFAULT 'WARNING' CHECK (severity IN ('INFO','WARNING','CRITICAL')),
  window_sec    int NOT NULL DEFAULT 60,
  filters       jsonb NOT NULL DEFAULT '{}'::jsonb,  -- environment_id, test_id, transaction, server_id
  channel_ids   uuid[] NOT NULL DEFAULT '{}',
  cooldown_sec  int NOT NULL DEFAULT 300,
  enabled       boolean NOT NULL DEFAULT true,
  created_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Alert instances (one per rule+subject while firing)
CREATE TABLE alerts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_id         uuid REFERENCES alert_rules(id) ON DELETE SET NULL,
  project_id      uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  run_id          uuid REFERENCES test_runs(id) ON DELETE CASCADE,
  server_id       uuid REFERENCES servers(id) ON DELETE SET NULL,
  type            text NOT NULL,
  severity        text NOT NULL CHECK (severity IN ('INFO','WARNING','CRITICAL')),
  status          text NOT NULL DEFAULT 'FIRING' CHECK (status IN ('FIRING','ACKNOWLEDGED','RESOLVED')),
  subject         text NOT NULL DEFAULT '',
  title           text NOT NULL,
  message         text,
  value           double precision,
  threshold       double precision,
  fired_at        timestamptz NOT NULL DEFAULT now(),
  acknowledged_at timestamptz,
  acknowledged_by uuid REFERENCES users(id) ON DELETE SET NULL,
  resolved_at     timestamptz,
  last_evaluated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX alerts_status_idx ON alerts(project_id, status, fired_at DESC);
CREATE UNIQUE INDEX alerts_open_unique ON alerts(rule_id, subject) WHERE status <> 'RESOLVED';

CREATE TABLE alert_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  alert_id    uuid NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
  ts          timestamptz NOT NULL DEFAULT now(),
  kind        text NOT NULL CHECK (kind IN ('FIRED','ACKNOWLEDGED','RESOLVED','NOTIFIED','NOTIFY_FAILED','REFIRED')),
  channel_id  uuid,
  details     jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX alert_events_alert_idx ON alert_events(alert_id, ts);

CREATE TABLE notifications (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id     uuid REFERENCES users(id) ON DELETE CASCADE,   -- NULL = everyone in org
  alert_id    uuid REFERENCES alerts(id) ON DELETE CASCADE,
  severity    text NOT NULL DEFAULT 'INFO',
  title       text NOT NULL,
  body        text,
  link        text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE notification_reads (
  notification_id uuid NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  read_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (notification_id, user_id)
);

-- ---------------------------------------------------------------------
-- Analysis results
-- ---------------------------------------------------------------------
CREATE TABLE sla_results (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id        uuid NOT NULL REFERENCES test_runs(id) ON DELETE CASCADE,
  rule_id       uuid REFERENCES sla_rules(id) ON DELETE SET NULL,
  profile_id    uuid REFERENCES sla_profiles(id) ON DELETE SET NULL,
  scope         text NOT NULL,
  transaction   text,
  metric        text NOT NULL,
  direction     text NOT NULL,
  actual_value  double precision,
  warning_value double precision,
  critical_value double precision,
  unit          text,
  status        text NOT NULL CHECK (status IN ('PASS','WARNING','FAIL','NO_DATA')),
  evaluated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sla_results_run_idx ON sla_results(run_id);

CREATE TABLE regressions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id           uuid NOT NULL REFERENCES test_runs(id) ON DELETE CASCADE,
  baseline_run_id  uuid REFERENCES test_runs(id) ON DELETE SET NULL,
  scope            text NOT NULL DEFAULT 'RUN',      -- RUN | TRANSACTION | INFRA
  transaction      text,
  metric           text NOT NULL,
  previous_value   double precision,
  current_value    double precision,
  change_pct       double precision,
  threshold_pct    double precision,
  direction        text NOT NULL,                    -- REGRESSION | IMPROVEMENT
  severity         text NOT NULL CHECK (severity IN ('INFO','WARNING','CRITICAL')),
  likely_impacted  text[] NOT NULL DEFAULT '{}',
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX regressions_run_idx ON regressions(run_id);

CREATE TABLE insights (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id           uuid NOT NULL REFERENCES test_runs(id) ON DELETE CASCADE,
  category         text NOT NULL,   -- BOTTLENECK, LATENCY, THROUGHPUT, ERRORS, INFRASTRUCTURE, JVM, DATABASE, REGRESSION, IMPROVEMENT, DATA_QUALITY
  severity         text NOT NULL CHECK (severity IN ('INFO','WARNING','CRITICAL')),
  title            text NOT NULL,
  description      text NOT NULL,
  evidence         jsonb NOT NULL DEFAULT '[]'::jsonb,
  confidence       double precision,     -- 0..1
  confidence_label text,                 -- Strong correlation | Likely bottleneck | Possible bottleneck | Insufficient evidence
  component        text,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX insights_run_idx ON insights(run_id);

CREATE TABLE recommendations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id      uuid NOT NULL REFERENCES test_runs(id) ON DELETE CASCADE,
  insight_id  uuid REFERENCES insights(id) ON DELETE CASCADE,
  category    text NOT NULL,
  priority    text NOT NULL DEFAULT 'MEDIUM' CHECK (priority IN ('LOW','MEDIUM','HIGH')),
  title       text NOT NULL,
  description text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX recommendations_run_idx ON recommendations(run_id);

CREATE TABLE comparisons (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  uuid REFERENCES projects(id) ON DELETE CASCADE,
  name        text NOT NULL,
  run_ids     uuid[] NOT NULL,
  created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- Integrations
-- ---------------------------------------------------------------------
CREATE TABLE integrations (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id        uuid REFERENCES projects(id) ON DELETE CASCADE,
  name              text NOT NULL,
  type              text NOT NULL CHECK (type IN ('JMETER','INFLUXDB','PROMETHEUS','GRAFANA','DYNATRACE','OPENTELEMETRY','JENKINS','GITHUB_ACTIONS','GITLAB','AZURE_DEVOPS')),
  url               text,
  auth_type         text NOT NULL DEFAULT 'NONE' CHECK (auth_type IN ('NONE','TOKEN','BASIC','API_KEY')),
  config            jsonb NOT NULL DEFAULT '{}'::jsonb,     -- non-secret: org, bucket, measurement, mappings
  status            text NOT NULL DEFAULT 'ENABLED' CHECK (status IN ('ENABLED','DISABLED')),
  health            text NOT NULL DEFAULT 'UNKNOWN' CHECK (health IN ('HEALTHY','DEGRADED','DOWN','UNKNOWN')),
  last_connected_at timestamptz,
  last_error        text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE integration_credentials (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  integration_id uuid NOT NULL REFERENCES integrations(id) ON DELETE CASCADE,
  name           text NOT NULL,          -- token | password | username
  ciphertext     text NOT NULL,          -- base64(iv|tag|ciphertext) AES-256-GCM
  key_version    int NOT NULL DEFAULT 1,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (integration_id, name)
);

-- ---------------------------------------------------------------------
-- Platform: jobs, audit, settings
-- ---------------------------------------------------------------------
CREATE TABLE background_jobs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type         text NOT NULL,
  status       text NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED','PROCESSING','COMPLETED','FAILED')),
  payload      jsonb NOT NULL DEFAULT '{}'::jsonb,
  result       jsonb,
  error        text,
  run_id       uuid REFERENCES test_runs(id) ON DELETE CASCADE,
  priority     int NOT NULL DEFAULT 5,
  attempts     int NOT NULL DEFAULT 0,
  max_attempts int NOT NULL DEFAULT 3,
  run_after    timestamptz NOT NULL DEFAULT now(),
  locked_at    timestamptz,
  locked_by    text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  started_at   timestamptz,
  finished_at  timestamptz
);
CREATE INDEX background_jobs_pick_idx ON background_jobs(status, priority, run_after) WHERE status = 'QUEUED';
CREATE INDEX background_jobs_run_idx ON background_jobs(run_id);
CREATE INDEX background_jobs_created_idx ON background_jobs(created_at DESC);

CREATE TABLE audit_logs (
  id            bigserial PRIMARY KEY,
  ts            timestamptz NOT NULL DEFAULT now(),
  organization_id uuid,
  user_id       uuid,
  user_email    text,
  api_key_id    uuid,
  action        text NOT NULL,
  resource_type text NOT NULL,
  resource_id   text,
  ip            text,
  user_agent    text,
  result        text NOT NULL DEFAULT 'SUCCESS' CHECK (result IN ('SUCCESS','FAILURE','DENIED')),
  details       jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX audit_logs_ts_idx ON audit_logs(ts DESC);
CREATE INDEX audit_logs_resource_idx ON audit_logs(resource_type, resource_id);
CREATE INDEX audit_logs_user_idx ON audit_logs(user_id, ts DESC);

CREATE TABLE system_settings (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  key             text NOT NULL,
  value           jsonb NOT NULL,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  updated_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  PRIMARY KEY (organization_id, key)
);

-- Pending purge requests: retention never hard-deletes without confirmation.
CREATE TABLE retention_purges (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  data_type       text NOT NULL,
  cutoff          timestamptz NOT NULL,
  estimated_rows  bigint,
  status          text NOT NULL DEFAULT 'PENDING_CONFIRMATION' CHECK (status IN ('PENDING_CONFIRMATION','CONFIRMED','EXECUTED','CANCELLED')),
  requested_at    timestamptz NOT NULL DEFAULT now(),
  confirmed_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  confirmed_at    timestamptz,
  executed_at     timestamptz,
  deleted_rows    bigint
);
