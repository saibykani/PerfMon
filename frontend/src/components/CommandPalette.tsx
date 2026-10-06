import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Search, CornerDownLeft } from 'lucide-react';
import { api } from '@/services/api';
import { NAV } from './nav';

interface Cmd { id: string; group: string; title: string; subtitle?: string; run: () => void }
interface SearchHit { type: string; id: string; title: string; subtitle?: string; url: string }

/** Ctrl/⌘+K global command palette: navigation, actions and global search (Run IDs, tests, apps, endpoints...). */
export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [idx, setIdx] = useState(0);
  const nav = useNavigate();

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setOpen((v) => !v); setQ(''); setIdx(0); }
      if (e.key === 'Escape') setOpen(false);
    };
    const openEv = () => { setOpen(true); setQ(''); setIdx(0); };
    window.addEventListener('keydown', h);
    window.addEventListener('perfmon:command-palette', openEv);
    return () => { window.removeEventListener('keydown', h); window.removeEventListener('perfmon:command-palette', openEv); };
  }, []);

  const search = useQuery({
    queryKey: ['search', q],
    queryFn: () => api.get<{ items: SearchHit[] }>('/search', { q }),
    enabled: open && q.trim().length >= 2,
    staleTime: 10000,
  });

  const go = (url: string) => { setOpen(false); nav(url); };
  const commands = useMemo<Cmd[]>(() => {
    const needle = q.trim().toLowerCase();
    const actions: Cmd[] = [
      { id: 'a-compare', group: 'Actions', title: 'Compare last 2 runs', run: async () => {
        const r = await api.get<{ items: { runId: string }[] }>('/runs', { status: 'COMPLETED', pageSize: 2 });
        go(r.items.length >= 2 ? `/compare?runs=${r.items[1].runId},${r.items[0].runId}` : '/compare');
      } },
      { id: 'a-live', group: 'Actions', title: 'Open Live Monitoring', run: () => go('/live') },
      { id: 'a-reports', group: 'Actions', title: 'Open reports', run: () => go('/reports') },
      { id: 'a-regression', group: 'Actions', title: 'Open Regression Dashboard', run: () => go('/regression') },
      { id: 'a-newdash', group: 'Actions', title: 'Create dashboard', run: () => go('/dashboards/new') },
      { id: 'a-help', group: 'Actions', title: 'Open user manual', run: () => go('/help') },
    ];
    const pages: Cmd[] = NAV.map((n) => ({ id: 'p' + n.to, group: 'Go to', title: n.label, subtitle: n.section, run: () => go(n.to) }));
    const runMatch = /^pf-\d{4}-\d{2}-\d{2}-\d+$/i.test(q.trim()) ? [{ id: 'run-direct', group: 'Run', title: `Open Run ${q.trim().toUpperCase()}`, run: () => go(`/runs/${q.trim().toUpperCase()}`) }] : [];
    const hits: Cmd[] = (search.data?.items ?? []).map((h) => ({ id: `${h.type}:${h.id}`, group: h.type, title: h.title, subtitle: h.subtitle, run: () => go(h.url) }));
    const filter = (c: Cmd) => !needle || `${c.title} ${c.subtitle ?? ''}`.toLowerCase().includes(needle);
    return [...runMatch, ...hits, ...actions.filter(filter), ...pages.filter(filter)].slice(0, 60);
  }, [q, search.data]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => setIdx(0), [q]);
  if (!open) return null;

  let lastGroup = '';
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && setOpen(false)}>
      <div className="cmdk" role="dialog" aria-label="Command palette">
        <div className="row" style={{ paddingLeft: 14 }}>
          <Search size={16} className="muted" />
          <input autoFocus placeholder="Search Run ID, test, application, endpoint… or type a command" value={q} onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') { e.preventDefault(); setIdx((i) => Math.min(commands.length - 1, i + 1)); }
              if (e.key === 'ArrowUp') { e.preventDefault(); setIdx((i) => Math.max(0, i - 1)); }
              if (e.key === 'Enter') commands[idx]?.run();
            }} />
        </div>
        <div className="cmdk-list" role="listbox">
          {search.isFetching && <div className="cmdk-group">Searching…</div>}
          {commands.map((c, i) => {
            const header = c.group !== lastGroup ? <div className="cmdk-group">{c.group}</div> : null;
            lastGroup = c.group;
            return (
              <div key={c.id}>
                {header}
                <div className={`cmdk-item ${i === idx ? 'on' : ''}`} role="option" aria-selected={i === idx} onMouseEnter={() => setIdx(i)} onClick={() => c.run()}>
                  <span className="t">{c.title}</span>{c.subtitle && <span className="s">{c.subtitle}</span>}
                  {i === idx && <CornerDownLeft size={13} className="muted" />}
                </div>
              </div>
            );
          })}
          {!commands.length && <div className="empty">No matches</div>}
        </div>
        <div className="row muted" style={{ padding: '6px 12px', borderTop: '1px solid var(--border)', fontSize: 11 }}>
          <span className="kbd">↑↓</span> navigate <span className="kbd">Enter</span> open <span className="kbd">Esc</span> close
        </div>
      </div>
    </div>
  );
}
