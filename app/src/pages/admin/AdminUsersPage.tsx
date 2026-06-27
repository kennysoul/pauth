import { useCallback, useEffect, useState } from 'react';
import { api, type AdminUser } from '../../api';

type Props = {
  status: string;
  title: string;
};

export function AdminUsersPage({ status, title }: Props) {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const q = status === 'all' ? '' : `?status=${status}`;
      setUsers(await api<AdminUser[]>(`/api/admin/users${q}`));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed');
    }
  }, [status]);

  useEffect(() => {
    load();
  }, [load]);

  async function approve(id: string) {
    await api(`/api/admin/users/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'active' }),
    });
    load();
  }

  async function reject(id: string) {
    if (!confirm('确定拒绝并删除该用户？')) return;
    await api(`/api/admin/users/${id}`, { method: 'DELETE' });
    load();
  }

  async function disable(id: string) {
    if (!confirm('确定禁用该用户？')) return;
    await api(`/api/admin/users/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'disabled' }),
    });
    load();
  }

  return (
    <>
      <h1>{title}</h1>
      {error && <p className="error">{error}</p>}
      <table>
        <thead>
          <tr>
            <th>名字</th>
            <th>邮箱</th>
            <th>角色</th>
            <th>状态</th>
            <th>Passkey</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {users.map((u) => (
            <tr key={u.id}>
              <td>{u.name}</td>
              <td>{u.email}</td>
              <td>{u.role}</td>
              <td>
                <span className={`badge ${u.status}`}>{u.status}</span>
              </td>
              <td>{u.passkeyCount}</td>
              <td className="actions">
                {u.status === 'pending' && (
                  <>
                    <button onClick={() => approve(u.id)}>批准</button>
                    <button className="secondary" onClick={() => reject(u.id)}>
                      拒绝
                    </button>
                  </>
                )}
                {u.status === 'active' && u.role !== 'admin' && (
                  <button className="secondary" onClick={() => disable(u.id)}>
                    禁用
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
