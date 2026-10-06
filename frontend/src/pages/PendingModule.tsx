import { useLocation } from 'react-router-dom';
import { NAV } from '@/components/nav';

/** Placeholder for modules whose UI ships in a later phase (backend APIs may already exist). */
export function PendingModule({ phase }: { phase: string }) {
  const loc = useLocation();
  const item = NAV.find((n) => n.to !== '/' && loc.pathname.startsWith(n.to));
  return (
    <div>
      <div className="page-head"><h1>{item?.label ?? 'Module'}</h1></div>
      <div className="notice">This module's UI is scheduled for {phase}. See the API reference at <a href="/api/docs" target="_blank" rel="noreferrer">/api/docs</a>.</div>
    </div>
  );
}
