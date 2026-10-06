import { useEffect, useRef, useState } from 'react';
import { API_BASE, tokenStore } from '@/services/api';

export interface LivePoint { t: number; count: number; errors: number; tps: number; errorPct: number | null; avg: number | null; p50: number | null; p90: number | null; p95: number | null; p99: number | null; users: number | null; min: number | null; max: number | null }

export interface LiveState {
  connected: boolean;
  run: { status: string; result: string | null; performance_score: number | null; started_at: string | null; ended_at: string | null; live_last_ingest_at: string | null } | null;
  points: LivePoint[];
  totals: any;
  last60s: any;
  infra: { cpu: number | null; mem: number | null } | null;
  percentileMethod: string | null;
  error: string | null;
}

/**
 * Subscribe to a run's live stream (Server-Sent Events). Points are merged by timestamp
 * (late data for an already-seen bucket replaces it). `intervalSec` is the configurable refresh.
 */
export function useLiveRun(runId: string | null | undefined, intervalSec = 5, enabled = true): LiveState {
  const [state, setState] = useState<LiveState>({ connected: false, run: null, points: [], totals: null, last60s: null, infra: null, percentileMethod: null, error: null });
  const pts = useRef(new Map<number, LivePoint>());

  useEffect(() => {
    if (!runId || !enabled) return;
    pts.current = new Map();
    const url = `${API_BASE}/api/v1/runs/${encodeURIComponent(runId)}/stream?interval=${intervalSec}&access_token=${encodeURIComponent(tokenStore.get() ?? '')}`;
    const es = new EventSource(url);
    es.onopen = () => setState((s) => ({ ...s, connected: true, error: null }));
    es.onerror = () => setState((s) => ({ ...s, connected: false, error: 'Live connection interrupted — retrying…' }));
    es.addEventListener('metrics', (ev) => {
      const d = JSON.parse((ev as MessageEvent).data);
      for (const p of d.points as LivePoint[]) pts.current.set(p.t, p);
      const points = [...pts.current.values()].sort((a, b) => a.t - b.t);
      setState({ connected: true, run: d.run, points, totals: d.totals, last60s: d.last60s, infra: d.infra, percentileMethod: d.percentileMethod, error: null });
    });
    es.addEventListener('status', (ev) => {
      const d = JSON.parse((ev as MessageEvent).data);
      setState((s) => ({ ...s, run: s.run ? { ...s.run, status: d.status ?? s.run.status, result: d.result ?? s.run.result } : s.run }));
    });
    return () => es.close();
  }, [runId, intervalSec, enabled]);

  return state;
}
