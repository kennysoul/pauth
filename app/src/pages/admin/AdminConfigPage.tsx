import { useEffect, useState } from 'react';
import { api } from '../../api';

export function AdminConfigPage() {
  const [registrationEnabled, setRegistrationEnabled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<string | null>(null);
  const [resetOpen, setResetOpen] = useState(false);
  const [resetText, setResetText] = useState('');

  useEffect(() => {
    api<{ registrationEnabled: boolean }>('/api/admin/config')
      .then((c) => setRegistrationEnabled(c.registrationEnabled))
      .finally(() => setLoading(false));
  }, []);

  async function toggleRegistration(enabled: boolean) {
    await api('/api/admin/config', {
      method: 'PATCH',
      body: JSON.stringify({ registrationEnabled: enabled }),
    });
    setRegistrationEnabled(enabled);
    setMessage(enabled ? '已开放注册' : '已关闭注册');
  }

  async function resetSystem() {
    await api('/api/admin/system/reset', {
      method: 'POST',
      body: JSON.stringify({ confirmation: resetText }),
    });
    window.location.href = '/setup';
  }

  if (loading) return <p className="sub">加载中…</p>;

  return (
    <>
      <h1>系统设置</h1>
      {message && <p className="success">{message}</p>}

      <div className="card" style={{ maxWidth: 480 }}>
        <div className="toggle-row">
          <span>允许用户注册</span>
          <button
            onClick={() => toggleRegistration(!registrationEnabled)}
          >
            {registrationEnabled ? '关闭' : '开启'}
          </button>
        </div>
        <p className="sub">新用户注册后必须经管理员审批才能登录（不可关闭）。</p>
      </div>

      <div className="danger-zone card" style={{ maxWidth: 480 }}>
        <h2>危险操作</h2>
        <p className="sub">重置将清空所有用户与 Passkey，系统回到初始化状态。</p>
        {!resetOpen ? (
          <button onClick={() => setResetOpen(true)}>重置整个认证系统</button>
        ) : (
          <>
            <label htmlFor="confirm">输入 RESET_ALL_I_UNDERSTAND 确认</label>
            <input
              id="confirm"
              value={resetText}
              onChange={(e) => setResetText(e.target.value)}
            />
            <button
              disabled={resetText !== 'RESET_ALL_I_UNDERSTAND'}
              onClick={resetSystem}
            >
              确认重置
            </button>
            <button
              className="secondary"
              style={{ marginLeft: '0.5rem' }}
              onClick={() => setResetOpen(false)}
            >
              取消
            </button>
          </>
        )}
      </div>
    </>
  );
}
