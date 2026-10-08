import { useEffect, useState } from 'react';
import { onApiWaking } from '@/services/api';

/** Shown while requests wait for a sleeping / restarting Perfmon server to come back. */
export function WakingBanner({ className = '' }: { className?: string }) {
  const [waking, setWaking] = useState(false);
  const [secs, setSecs] = useState(0);
  useEffect(() => onApiWaking(setWaking), []);
  useEffect(() => {
    if (!waking) { setSecs(0); return; }
    const t = setInterval(() => setSecs((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [waking]);
  // brief hiccups resolve on their own — only announce waits that are noticeable
  if (!waking || secs < 2) return null;
  return (
    <div className={`waking ${className}`} role="status" aria-live="polite">
      <span className="waking-spin" aria-hidden="true" />
      <span><b>Connecting to Perfmon…</b> {secs}s — starting up, this usually takes under a minute. You don’t need to do anything.</span>
    </div>
  );
}
