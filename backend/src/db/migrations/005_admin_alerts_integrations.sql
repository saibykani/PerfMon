-- Administration, alerting and integration support columns/indexes.

-- Retention purge requests: who asked, failures, per-type details
ALTER TABLE retention_purges
  ADD COLUMN IF NOT EXISTS requested_by uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS error text,
  ADD COLUMN IF NOT EXISTS details jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE retention_purges DROP CONSTRAINT IF EXISTS retention_purges_status_check;
ALTER TABLE retention_purges ADD CONSTRAINT retention_purges_status_check
  CHECK (status IN ('PENDING_CONFIRMATION','CONFIRMED','EXECUTING','EXECUTED','CANCELLED','FAILED'));
CREATE INDEX IF NOT EXISTS retention_purges_org_idx ON retention_purges(organization_id, requested_at DESC);

-- Notification channels / integrations: change tracking
ALTER TABLE notification_channels
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE integrations
  ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS last_import_at timestamptz;

-- Query paths used by the alerts / notifications / audit screens
CREATE INDEX IF NOT EXISTS notifications_org_created_idx ON notifications(organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS notifications_user_idx ON notifications(user_id) WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS alerts_rule_idx ON alerts(rule_id);
CREATE INDEX IF NOT EXISTS alert_rules_project_idx ON alert_rules(project_id);
CREATE INDEX IF NOT EXISTS audit_logs_org_ts_idx ON audit_logs(organization_id, ts DESC);
CREATE INDEX IF NOT EXISTS audit_logs_action_idx ON audit_logs(action);
CREATE INDEX IF NOT EXISTS integrations_org_idx ON integrations(organization_id);
CREATE INDEX IF NOT EXISTS api_keys_org_idx ON api_keys(organization_id);
CREATE INDEX IF NOT EXISTS background_jobs_type_idx ON background_jobs(type, created_at DESC);
