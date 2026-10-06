import { lazy, Suspense, useEffect, type ComponentType } from 'react';
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '@/stores/auth';
import { setUnauthorizedHandler } from '@/services/api';
import { Layout } from '@/components/Layout';
import { LoginPage, ForgotPasswordPage, ResetPasswordPage } from '@/pages/LoginPage';
import { RunsPage } from '@/pages/RunsPage';
import { Loading } from '@/components/ui';

/** Lazy-load a named export so each module is its own chunk. */
const page = <K extends string>(loader: () => Promise<Record<K, ComponentType<any>>>, name: K) =>
  lazy(() => loader().then((m) => ({ default: m[name] })));

const OverviewPage = page(() => import('@/pages/OverviewPage'), 'OverviewPage');
const ProjectsPage = page(() => import('@/pages/projects/ProjectsPage'), 'ProjectsPage');
const ProjectDetailPage = page(() => import('@/pages/projects/ProjectDetailPage'), 'ProjectDetailPage');
const ApplicationsPage = page(() => import('@/pages/ApplicationsPage'), 'ApplicationsPage');
const TestsPage = page(() => import('@/pages/tests/TestsPage'), 'TestsPage');
const TestDetailPage = page(() => import('@/pages/tests/TestDetailPage'), 'TestDetailPage');
const RunDetailPage = page(() => import('@/pages/run/RunDetailPage'), 'RunDetailPage');
const DashboardsPage = page(() => import('@/pages/dashboards/DashboardsPage'), 'DashboardsPage');
const DashboardViewPage = page(() => import('@/pages/dashboards/DashboardViewPage'), 'DashboardViewPage');
const LivePage = page(() => import('@/pages/LivePage'), 'LivePage');
const TransactionsPage = page(() => import('@/pages/TransactionsPage'), 'TransactionsPage');
const ApisPage = page(() => import('@/pages/ApisPage'), 'ApisPage');
const InfrastructurePage = page(() => import('@/pages/InfrastructurePage'), 'InfrastructurePage');
const AppMonitoringPage = page(() => import('@/pages/AppMonitoringPage'), 'AppMonitoringPage');
const DatabasesPage = page(() => import('@/pages/DatabasesPage'), 'DatabasesPage');
const EventsPage = page(() => import('@/pages/EventsPage'), 'EventsPage');
const SlaPage = page(() => import('@/pages/SlaPage'), 'SlaPage');
const AlertsPage = page(() => import('@/pages/AlertsPage'), 'AlertsPage');
const InsightsPage = page(() => import('@/pages/InsightsPage'), 'InsightsPage');
const RegressionPage = page(() => import('@/pages/RegressionPage'), 'RegressionPage');
const ComparePage = page(() => import('@/pages/ComparePage'), 'ComparePage');
const TrendsPage = page(() => import('@/pages/TrendsPage'), 'TrendsPage');
const CapacityPage = page(() => import('@/pages/CapacityPage'), 'CapacityPage');
const ReportsPage = page(() => import('@/pages/reports/ReportsPage'), 'ReportsPage');
const ReportViewPage = page(() => import('@/pages/reports/ReportViewPage'), 'ReportViewPage');
const ArtifactsPage = page(() => import('@/pages/ArtifactsPage'), 'ArtifactsPage');
const ReleasesPage = page(() => import('@/pages/ReleasesPage'), 'ReleasesPage');
const IntegrationsPage = page(() => import('@/pages/IntegrationsPage'), 'IntegrationsPage');
const AdminPage = page(() => import('@/pages/admin/AdminPage'), 'AdminPage');
const HelpPage = page(() => import('@/pages/HelpPage'), 'HelpPage');

function RequireAuth({ children }: { children: JSX.Element }) {
  const { user, loading } = useAuth();
  const loc = useLocation();
  if (loading) return <div style={{ padding: 24 }}><Loading /></div>;
  if (!user) return <Navigate to="/login" replace state={{ from: loc.pathname + loc.search }} />;
  return children;
}

export function App() {
  const load = useAuth((s) => s.load);
  const nav = useNavigate();
  useEffect(() => {
    load();
    setUnauthorizedHandler(() => { useAuth.setState({ user: null }); nav('/login'); });
  }, [load, nav]);

  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/forgot-password" element={<ForgotPasswordPage />} />
      <Route path="/reset-password" element={<ResetPasswordPage />} />
      <Route element={<RequireAuth><Layout /></RequireAuth>}>
        <Route index element={<S><OverviewPage /></S>} />
        <Route path="projects" element={<S><ProjectsPage /></S>} />
        <Route path="projects/:id" element={<S><ProjectDetailPage /></S>} />
        <Route path="applications" element={<S><ApplicationsPage /></S>} />
        <Route path="tests" element={<S><TestsPage /></S>} />
        <Route path="tests/:id" element={<S><TestDetailPage /></S>} />
        <Route path="runs" element={<RunsPage />} />
        <Route path="runs/:runId" element={<S><RunDetailPage /></S>} />
        <Route path="runs/:runId/:tab" element={<S><RunDetailPage /></S>} />
        <Route path="dashboards" element={<S><DashboardsPage /></S>} />
        <Route path="dashboards/:uid" element={<S><DashboardViewPage /></S>} />
        <Route path="live" element={<S><LivePage /></S>} />
        <Route path="live/:runId" element={<S><LivePage /></S>} />
        <Route path="transactions" element={<S><TransactionsPage /></S>} />
        <Route path="apis" element={<S><ApisPage /></S>} />
        <Route path="infrastructure" element={<S><InfrastructurePage /></S>} />
        <Route path="app-monitoring" element={<S><AppMonitoringPage /></S>} />
        <Route path="databases" element={<S><DatabasesPage /></S>} />
        <Route path="events" element={<S><EventsPage /></S>} />
        <Route path="sla" element={<S><SlaPage /></S>} />
        <Route path="alerts" element={<S><AlertsPage /></S>} />
        <Route path="insights" element={<S><InsightsPage /></S>} />
        <Route path="regression" element={<S><RegressionPage /></S>} />
        <Route path="compare" element={<S><ComparePage /></S>} />
        <Route path="trends" element={<S><TrendsPage /></S>} />
        <Route path="capacity" element={<S><CapacityPage /></S>} />
        <Route path="reports" element={<S><ReportsPage /></S>} />
        <Route path="reports/:id" element={<S><ReportViewPage /></S>} />
        <Route path="artifacts" element={<S><ArtifactsPage /></S>} />
        <Route path="releases" element={<S><ReleasesPage /></S>} />
        <Route path="integrations" element={<S><IntegrationsPage /></S>} />
        <Route path="admin" element={<S><AdminPage /></S>} />
        <Route path="admin/:tab" element={<S><AdminPage /></S>} />
        <Route path="help" element={<S><HelpPage /></S>} />
        <Route path="help/:section" element={<S><HelpPage /></S>} />
        <Route path="*" element={<div className="empty">Page not found</div>} />
      </Route>
    </Routes>
  );
}

function S({ children }: { children: JSX.Element }) {
  return <Suspense fallback={<Loading height={200} />}>{children}</Suspense>;
}
