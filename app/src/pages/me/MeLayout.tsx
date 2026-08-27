import { useEffect, useState } from 'react';
import { NavLink, Navigate, Outlet } from 'react-router-dom';
import { api, type Me } from '../../api';

function navClass({ isActive }: { isActive: boolean }) {
  return isActive ? 'active' : undefined;
}

export function MeLayout() {
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

  return (
    <div className="admin-layout">
      <aside className="admin-nav">
        <div className="admin-nav-user">
          <div className="admin-nav-kicker">Passkey Auth</div>
          <div className="admin-nav-title">{me.name}</div>
        </div>
        <nav className="admin-nav-group">
          <div className="admin-nav-group-title">账户</div>
          <NavLink to="/me/profile" className={navClass}>
            用户信息
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
