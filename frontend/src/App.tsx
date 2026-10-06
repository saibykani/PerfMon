import { useEffect } from 'react';
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '@/stores/auth';
import { setUnauthorizedHandler } from '@/services/api';
import { Layout } from '@/components/Layout';
import { LoginPage, ForgotPasswordPage, ResetPasswordPage } from '@/pages/LoginPage';
import { RunsPage } from '@/pages/RunsPage';
import { PendingModule } from '@/pages/PendingModule';

function RequireAuth({ children }: { children: JSX.Element }) {
  const { user, loading } = useAuth();
  const loc = useLocation();
  if (loading) return <div className="empty">Loading…</div>;
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
        <Route index element={<RunsPage />} />
        <Route path="runs" element={<RunsPage />} />
        <Route path="*" element={<PendingModule phase="a later phase" />} />
      </Route>
    </Routes>
  );
}
