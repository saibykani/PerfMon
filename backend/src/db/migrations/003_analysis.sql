ALTER TABLE test_runs
  ADD COLUMN result_breakdown jsonb,
  ADD COLUMN score_breakdown jsonb,
  ADD COLUMN analysis jsonb,          -- bottleneck candidates, saturation, evidence gaps, baseline used
  ADD COLUMN analyzed_at timestamptz;
