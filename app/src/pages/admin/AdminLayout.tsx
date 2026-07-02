import { useEffect, useState } from 'react';
import { NavLink, Navigate, Outlet } from 'react-router-dom';
import { api, type Me } from '../../api';

function navClass({ isActive }: { isActive: boolean }) {
  return isActive ? 'active' : undefined;
}

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
        <NavLink to="/login">返回登录</NavLink>
      </div>
    );
  }

  return (
    <div className="admin-layout">
      <aside className="admin-nav">
        <div className="admin-nav-user">
          <div className="admin-nav-kicker">Passkey Auth</div>
          <div className="admin-nav-title">{me.name}</div>
        </div>
        <nav className="admin-nav-group">
          <div className="admin-nav-group-title">管理</div>
          <NavLink to="/admin/users" className={navClass}>
            用户管理
          </NavLink>
          <NavLink to="/admin/clients" className={navClass}>
            应用管理
          </NavLink>
          <NavLink to="/admin/integration" className={navClass}>
            集成与安全
          </NavLink>
          <NavLink to="/admin/config" className={navClass}>
            系统设置
          </NavLink>
          <NavLink to="/admin/logs" className={navClass}>
            审计日志
          </NavLink>
        </nav>
        <div className="admin-nav-foot">
          <button type="button" className="secondary nav-item" onClick={logout}>
            登出
          </button>
        </div>
      </aside>
      <main className="admin-main">
        <Outlet />
      </main>
    </div>
  );
}
