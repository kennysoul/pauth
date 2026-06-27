import { useEffect, useState } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { api, type SystemState } from './api';
import { SetupPage } from './pages/SetupPage';
import { LoginPage } from './pages/LoginPage';
import { RegisterPage } from './pages/RegisterPage';
import { AdminLayout } from './pages/admin/AdminLayout';
import { AdminUsersPage } from './pages/admin/AdminUsersPage';
import { AdminConfigPage } from './pages/admin/AdminConfigPage';
import { AdminLogsPage } from './pages/admin/AdminLogsPage';

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
      <Route path="/admin" element={<AdminLayout />}>
        <Route index element={<AdminUsersPage status="all" title="用户概览" />} />
        <Route path="users" element={<AdminUsersPage status="all" title="用户管理" />} />
        <Route path="pending" element={<AdminUsersPage status="pending" title="待审批" />} />
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
