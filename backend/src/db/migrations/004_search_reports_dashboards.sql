-- Global search (trigram), report versioning and dashboard lookups.
CREATE INDEX IF NOT EXISTS performance_tests_name_trgm ON performance_tests USING gin (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS applications_name_trgm ON applications USING gin (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS projects_name_trgm ON projects USING gin (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS transactions_name_trgm ON transactions USING gin (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS api_endpoints_path_trgm ON api_endpoints USING gin (path_template gin_trgm_ops);
CREATE INDEX IF NOT EXISTS builds_number_trgm ON builds USING gin (build_number gin_trgm_ops);
CREATE INDEX IF NOT EXISTS releases_version_trgm ON releases USING gin (version gin_trgm_ops);
CREATE INDEX IF NOT EXISTS reports_title_trgm ON reports USING gin (title gin_trgm_ops);
CREATE INDEX IF NOT EXISTS dashboards_name_trgm ON dashboards USING gin (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS test_runs_commit_idx ON test_runs (commit_sha text_pattern_ops);

-- Report versions: same type + run (or same subject for multi-run/test reports) => version N+1
CREATE INDEX IF NOT EXISTS reports_version_idx ON reports (project_id, type, run_id, version DESC);
CREATE INDEX IF NOT EXISTS reports_subject_idx ON reports (project_id, type, (params->>'subjectKey'), version DESC);

CREATE INDEX IF NOT EXISTS dashboards_org_idx ON dashboards (organization_id, project_id);
CREATE INDEX IF NOT EXISTS dashboard_variables_dash_idx ON dashboard_variables (dashboard_id);
CREATE INDEX IF NOT EXISTS annotations_run_idx ON annotations (run_id, ts);
CREATE INDEX IF NOT EXISTS annotations_dashboard_idx ON annotations (dashboard_id);
CREATE INDEX IF NOT EXISTS comparisons_project_idx ON comparisons (project_id, created_at DESC);
