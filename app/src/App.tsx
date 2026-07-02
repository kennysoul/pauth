import { useEffect, useState } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { api, type SystemState } from './api';
import { SetupPage } from './pages/SetupPage';
import { LoginPage } from './pages/LoginPage';
import { RegisterPage } from './pages/RegisterPage';
import { LinkDevicePage } from './pages/LinkDevicePage';
import { AdminLayout } from './pages/admin/AdminLayout';
import { AdminUsersPage } from './pages/admin/AdminUsersPage';
import { AdminClientsPage } from './pages/admin/AdminClientsPage';
import { AdminConfigPage } from './pages/admin/AdminConfigPage';
import { AdminIntegrationPage } from './pages/admin/AdminIntegrationPage';
import { AdminLogsPage } from './pages/admin/AdminLogsPage';
import { InvitePage } from './pages/InvitePage';

export function App() {
  const [state, setState] = useState<SystemState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const location = useLocation();

  useEffect(() => {
    api<SystemState>('/api/system/state')
      .then(setState)
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load'));
  }, [location.pathname]);

  if (error) {
    return (
      <div className="container">
        <p className="error">{error}</p>
      </div>
    );
  }

  if (!state) {
    return (
      <div className="container">
        <p className="sub">加载中…</p>
      </div>
    );
  }

  if (state.state === 'NEEDS_SETUP' && !location.pathname.startsWith('/setup')) {
    return <Navigate to="/setup" replace />;
  }

  if (state.state === 'ACTIVE' && location.pathname.startsWith('/setup')) {
    return <Navigate to="/login" replace />;
  }

  return (
    <Routes>
      <Route path="/setup" element={<SetupPage />} />
      <Route path="/login" element={<LoginPage registrationEnabled={state.registrationEnabled} />} />
      <Route
        path="/register"
        element={
          state.registrationEnabled ? (
            <RegisterPage />
          ) : (
            <Navigate to="/login" replace />
          )
        }
      />
      <Route path="/invite/:token" element={<InvitePage />} />
      <Route path="/link-device" element={<LinkDevicePage />} />
      <Route path="/admin" element={<AdminLayout />}>
        <Route index element={<Navigate to="/admin/users" replace />} />
        <Route path="users" element={<AdminUsersPage />} />
        <Route path="pending" element={<Navigate to="/admin/users" replace />} />
        <Route path="clients" element={<AdminClientsPage />} />
        <Route path="integration" element={<AdminIntegrationPage />} />
        <Route path="config" element={<AdminConfigPage />} />
        <Route path="logs" element={<AdminLogsPage />} />
      </Route>
      <Route
        path="/"
        element={
          <Navigate to={state.state === 'NEEDS_SETUP' ? '/setup' : '/login'} replace />
        }
      />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
