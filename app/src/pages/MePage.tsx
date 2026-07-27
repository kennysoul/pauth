import { useEffect, useState } from 'react';
import { startRegistration } from '@simplewebauthn/browser';
import { api, type Me } from '../api';
import { useToast } from '../components/useToast';

type MePasskey = {
  id: string;
  credentialId: string;
  deviceType: string | null;
  backedUp: boolean;
  createdAt: string;
  lastUsedAt: string | null;
};

export function MePage() {
  const { showToast, toastEl } = useToast();
  const [user, setUser] = useState<Me | null>(null);
  const [passkeys, setPasskeys] = useState<MePasskey[]>([]);
  const [editingEmail, setEditingEmail] = useState(false);
  const [newEmail, setNewEmail] = useState('');
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true);
    try {
      const [u, pks] = await Promise.all([
        api<Me>('/api/me'),
        api<MePasskey[]>('/api/me/passkeys'),
      ]);
      setUser(u);
      setPasskeys(pks);
      setNewEmail(u.email);
    } catch (e) {
      showToast(e instanceof Error ? e.message : '加载失败');
      if (e instanceof Error && e.message.includes('401')) {
        window.location.href = '/login';
      }
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function saveEmail() {
    try {
      await api<{ ok: boolean }>('/api/me/email', {
        method: 'PUT',
        body: JSON.stringify({ email: newEmail }),
      });
      showToast('邮箱已更新');
      setEditingEmail(false);
      load();
    } catch (e) {
      showToast(e instanceof Error ? e.message : '更新失败');
    }
  }

  async function addPasskey() {
    try {
      const { options, challengeId } = await api<{
        options: Parameters<typeof startRegistration>[0]['optionsJSON'];
        challengeId: string;
      }>('/api/me/passkeys/options', { method: 'POST' });

      const registrationResponse = await startRegistration({ optionsJSON: options });

      await api<{ ok: boolean }>('/api/me/passkeys/verify', {
        method: 'POST',
        body: JSON.stringify({ challengeId, registrationResponse }),
      });

      showToast('Passkey 已添加');
      load();
    } catch (e) {
      showToast(e instanceof Error ? e.message : '添加失败');
    }
  }

  async function deletePasskey(id: string) {
    if (!window.confirm('确认删除这个 Passkey？')) return;
    try {
      await api<{ ok: boolean }>(`/api/me/passkeys/${id}`, { method: 'DELETE' });
      showToast('已删除');
      load();
    } catch (e) {
      showToast(e instanceof Error ? e.message : '删除失败');
    }
  }

  async function logout() {
    await api('/api/login/logout', { method: 'POST' });
    window.location.href = '/login';
  }

  if (loading) {
    return (
      <div className="container">
        <p className="sub">加载中…</p>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="container">
        <p className="error">加载失败</p>
      </div>
    );
  }

  return (
    <div className="container">
      <div className="card">
        <h1>我的账号</h1>
        <div className="config-field">
          <label>名字</label>
          <input value={user.name} readOnly />
        </div>
        <div className="config-field">
          <label>邮箱</label>
          {editingEmail ? (
            <div className="inline-edit-row">
              <input
                type="email"
                value={newEmail}
                onChange={(e) => setNewEmail(e.target.value)}
              />
              <button type="button" className="btn primary" onClick={saveEmail}>
                保存
              </button>
              <button
                type="button"
                className="btn secondary"
                onClick={() => setEditingEmail(false)}
              >
                取消
              </button>
            </div>
          ) : (
            <div className="inline-edit-row">
              <input value={user.email} readOnly />
              <button type="button" className="btn" onClick={() => setEditingEmail(true)}>
                修改
              </button>
            </div>
          )}
        </div>
        <div className="config-field">
          <label>角色</label>
          <input value={user.role === 'admin' ? '管理员' : '用户'} readOnly />
        </div>

        <h2 style={{ marginTop: '1.5rem' }}>Passkey</h2>
        <button type="button" className="btn primary" onClick={addPasskey}>
          添加 Passkey
        </button>
        {passkeys.length === 0 ? (
          <p className="sub">暂无 Passkey</p>
        ) : (
          <ul className="passkey-list">
            {passkeys.map((pk) => (
              <li key={pk.id} className="passkey-list-item">
                <span>
                  {pk.deviceType ?? '未知设备'} {pk.backedUp ? '(已备份)' : ''}
                </span>
                <button
                  type="button"
                  className="btn danger"
                  onClick={() => deletePasskey(pk.id)}
                  disabled={passkeys.length <= 1}
                >
                  删除
                </button>
              </li>
            ))}
          </ul>
        )}

        <button
          type="button"
          className="btn secondary"
          style={{ marginTop: '1.5rem' }}
          onClick={logout}
        >
          登出
        </button>
      </div>
      {toastEl}
    </div>
  );
}
