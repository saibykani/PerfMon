import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell, LogOut, Menu, Moon, Search, Sun } from 'lucide-react';
import { NAV } from './nav';
import { Logo } from './Logo';
import { CommandPalette } from './CommandPalette';
import { ChangePasswordDialog } from './ChangePasswordDialog';
import { useAuth } from '@/stores/auth';
import { useUi } from '@/stores/ui';
import { api } from '@/services/api';
import { fmtDate } from './format';

/** Stakeholder modes (spec §104): pages adapt their default emphasis to the selected view. */
export const VIEWS = [
  { key: 'PERFORMANCE_ENGINEER', label: 'Performance Engineer' },
  { key: 'QA', label: 'QA' },
  { key: 'DEVELOPER', label: 'Developer' },
  { key: 'SRE', label: 'SRE' },
  { key: 'ARCHITECT', label: 'Architect' },
  { key: 'MANAGER', label: 'Manager' },
];

function Notifications() {
  const [open, setOpen] = useState(false);
  const qc = useQueryClient();
  const nav = useNavigate();
  const { data } = useQuery({ queryKey: ['notifications'], queryFn: () => api.get<{ items: any[]; unread: number }>('/notifications', { limit: 20 }), refetchInterval: 30000, retry: false });
  const markAll = async () => { await api.post('/notifications/read-all').catch(() => undefined); qc.invalidateQueries({ queryKey: ['notifications'] }); };
  return (
    <div style={{ position: 'relative' }}>
      <button className="btn btn-ghost icon-btn" onClick={() => setOpen((v) => !v)} aria-label="Notifications" title="Notifications">
        <Bell size={15} />{!!data?.unread && <span className="notif-dot">{data.unread > 9 ? '9+' : data.unread}</span>}
      </button>
      {open && (
        <div className="dt-menu notif-menu" onMouseLeave={() => setOpen(false)}>
          <div className="row" style={{ padding: '4px 6px 8px' }}><b>Notifications</b><div className="spacer" /><button className="btn btn-sm btn-ghost" onClick={markAll}>Mark all read</button></div>
          {!data?.items.length && <div className="empty">You're all caught up.</div>}
          {data?.items.map((n) => (
            <div key={n.id} className={`notif-item ${n.read ? '' : 'unread'}`} onClick={() => { setOpen(false); if (n.link) { try { nav(new URL(n.link, window.location.origin).pathname); } catch { nav('/alerts'); } } }}>
              <span className={`badge ${n.severity === 'CRITICAL' ? 'fail' : n.severity === 'WARNING' ? 'warn' : 'info'}`}>{n.severity}</span>
              <div style={{ minWidth: 0 }}><div className="notif-title">{n.title}</div><div className="muted" style={{ fontSize: 11 }}>{fmtDate(n.created_at)}</div></div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function Layout() {
  const { user, logout, setUser } = useAuth();
  const [pwOpen, setPwOpen] = useState(false);
  const { theme, toggleTheme, sidebarOpen, setSidebar } = useUi();
  const nav = useNavigate();
  const loc = useLocation();
  useEffect(() => setSidebar(false), [loc.pathname, setSidebar]);

  let lastSection = '';
  return (
    <div className="app">
      <aside className={`sidebar ${sidebarOpen ? 'open' : ''}`} aria-label="Main navigation">
        <div className="brand">
          <Logo size={26} tagline={false} />
        </div>
        <nav className="nav">
          {NAV.map((item) => {
            const header = item.section !== lastSection ? item.section : null;
            lastSection = item.section;
            const Icon = item.icon;
            return (
              <div key={item.to}>
                {header && header !== 'Perfmon' && <div className="nav-section">{header}</div>}
                <NavLink to={item.to} end={item.to === '/'} className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
                  <Icon size={15} strokeWidth={1.8} />
                  <span>{item.label}</span>
                </NavLink>
              </div>
            );
          })}
        </nav>
      </aside>
      <div className="main">
        <header className="topbar">
          <button className="btn btn-ghost icon-btn mobile-only" onClick={() => setSidebar(!sidebarOpen)} aria-label="Toggle navigation"><Menu size={16} /></button>
          <button className="btn search-trigger" onClick={() => window.dispatchEvent(new Event('perfmon:command-palette'))} aria-label="Search (Ctrl+K)">
            <Search size={14} /><span>Search runs, tests, endpoints…</span><span className="kbd">Ctrl K</span>
          </button>
          <div className="spacer" />
          <select className="select view-select" title="Stakeholder view" aria-label="Stakeholder view" value={user?.preferredView ?? 'PERFORMANCE_ENGINEER'}
            onChange={async (e) => { const u = await api.patch<any>('/auth/me', { preferredView: e.target.value }); setUser(u); }}>
            {VIEWS.map((v) => <option key={v.key} value={v.key}>{v.label} view</option>)}
          </select>
          <Notifications />
          <button className="btn btn-ghost icon-btn" onClick={toggleTheme} title="Toggle light/dark theme" aria-label="Toggle theme">
            {theme === 'dark' ? <Sun size={15} /> : <Moon size={15} />}
          </button>
          <button className="avatar avatar-btn" title={`${user?.name} · ${user?.roles.join(', ')} — change password`} aria-label="Change password" onClick={() => setPwOpen(true)}>{user?.name?.split(' ').map((s) => s[0]).slice(0, 2).join('')}</button>
          <ChangePasswordDialog open={pwOpen} onClose={() => setPwOpen(false)} />
          <button className="btn btn-ghost icon-btn" title="Log out" aria-label="Log out" onClick={async () => { await logout(); nav('/login'); }}>
            <LogOut size={15} />
          </button>
        </header>
        <main className="content">
          <Outlet />
        </main>
      </div>
      <CommandPalette />
    </div>
  );
}
