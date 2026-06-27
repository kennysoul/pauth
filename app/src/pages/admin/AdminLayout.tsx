import { useEffect, useState } from 'react';
import { Link, Navigate, Outlet } from 'react-router-dom';
import { api, type Me } from '../../api';

export function AdminLayout() {
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<Me>('/api/me')
      .then(setMe)
      .catch((e) => setError(e instanceof Error ? e.message : 'Unauthorized'));
  }, []);

  async function logout() {
    await api('/api/login/logout', { method: 'POST' });
    window.location.href = '/login';
  }

  if (error) {
    return <Navigate to="/login" replace />;
  }

  if (!me) {
    return (
      <div className="container">
        <p className="sub">加载中…</p>
      </div>
    );
  }

  if (me.role !== 'admin') {
    return (
      <div className="container">
        <p className="error">需要管理员权限</p>
        <Link to="/login">返回登录</Link>
      </div>
    );
  }

  return (
    <div className="admin-layout">
      <aside className="admin-nav">
        <p>
          <strong>{me.name}</strong>
        </p>
        <nav>
          <Link to="/admin">概览</Link>
          <Link to="/admin/users">用户管理</Link>
          <Link to="/admin/pending">待审批</Link>
          <Link to="/admin/config">系统设置</Link>
          <Link to="/admin/logs">审计日志</Link>
        </nav>
        <button className="secondary" style={{ marginTop: '1rem' }} onClick={logout}>
          登出
        </button>
      </aside>
      <main className="admin-main">
        <Outlet />
      </main>
    </div>
  );
}
