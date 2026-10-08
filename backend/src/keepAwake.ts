/**
 * Keeps a free-tier host (Render) from putting the API to sleep: free web services stop after
 * ~15 minutes without inbound requests, and waking takes 30–60 s. Every few minutes the API
 * requests its own PUBLIC health URL, which counts as inbound traffic.
 * Enabled when KEEP_AWAKE_URL or RENDER_EXTERNAL_URL (set automatically by Render) is present.
 */
const INTERVAL_MS = 4 * 60_000;

export function startKeepAwake(log: (m: string) => void = console.log) {
  const base = (process.env.KEEP_AWAKE_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/$/, '');
  if (!base || process.env.KEEP_AWAKE === 'false') return;
  const url = `${base}/api/v1/health`;
  const ping = async () => {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(30_000), headers: { 'user-agent': 'perfmon-keep-awake' } });
      if (!r.ok) log(`[keep-awake] ${url} answered ${r.status}`);
    } catch (e) {
      log(`[keep-awake] ${url} failed: ${(e as Error).message}`);
    }
  };
  setInterval(ping, INTERVAL_MS).unref();
  setTimeout(ping, 30_000).unref();
  log(`[keep-awake] pinging ${url} every ${INTERVAL_MS / 60_000} min`);
}
