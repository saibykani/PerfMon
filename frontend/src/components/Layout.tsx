import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useEffect } from 'react';
import { LogOut, Menu, Moon, Sun } from 'lucide-react';
import { NAV } from './nav';
import { useAuth } from '@/stores/auth';
import { useUi } from '@/stores/ui';

export function Layout() {
  const { user, logout } = useAuth();
  const { theme, toggleTheme, sidebarOpen, setSidebar } = useUi();
  const nav = useNavigate();
  const loc = useLocation();
  useEffect(() => setSidebar(false), [loc.pathname, setSidebar]);

  let lastSection = '';
  return (
    <div className="app">
      <aside className={`sidebar ${sidebarOpen ? 'open' : ''}`} aria-label="Main navigation">
        <div className="brand">
          <img src="/favicon.svg" width={22} height={22} alt="" />
          <div>
            <div className="brand-name">PERFMON</div>
            <div className="brand-tag">Performance · Observability · Intelligence</div>
          </div>
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
          <div className="spacer" />
          <button className="btn btn-ghost icon-btn" onClick={toggleTheme} title="Toggle light/dark theme" aria-label="Toggle theme">
            {theme === 'dark' ? <Sun size={15} /> : <Moon size={15} />}
          </button>
          <div className="text-2" title={user?.roles.join(', ')}>{user?.name}</div>
          <button className="btn btn-ghost icon-btn" title="Log out" aria-label="Log out" onClick={async () => { await logout(); nav('/login'); }}>
            <LogOut size={15} />
          </button>
        </header>
        <main className="content">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
