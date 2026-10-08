-- Kubernetes monitoring: allow KUBERNETES connections in the integrations catalog.
ALTER TABLE integrations DROP CONSTRAINT IF EXISTS integrations_type_check;
ALTER TABLE integrations ADD CONSTRAINT integrations_type_check CHECK (type IN (
  'JMETER','INFLUXDB','PROMETHEUS','GRAFANA','DYNATRACE','OPENTELEMETRY','JENKINS','GITHUB_ACTIONS','GITLAB','AZURE_DEVOPS','KUBERNETES'));

-- Sampled pod/node usage lives in metric_points (source = 'kubernetes'); trend queries filter by metric + time + tags.
CREATE INDEX IF NOT EXISTS metric_points_k8s_ts_idx ON metric_points(ts) WHERE source = 'kubernetes';
