import { useState } from 'react';
import { startRegistration } from '@simplewebauthn/browser';
import { api } from '../api';

export function SetupPage() {
  const [name, setName] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSetup() {
    setLoading(true);
    setError(null);
    try {
      await api('/api/setup/begin', {
        method: 'POST',
        body: JSON.stringify({ name }),
      });

      const { options, challengeId } = await api<{
        options: Parameters<typeof startRegistration>[0]['optionsJSON'];
        challengeId: string;
      }>('/api/setup/passkey/options', { method: 'POST' });

      const registrationResponse = await startRegistration({ optionsJSON: options });

      const result = await api<{ redirect: string }>('/api/setup/passkey/verify', {
        method: 'POST',
        body: JSON.stringify({ challengeId, registrationResponse }),
      });

      window.location.href = result.redirect;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Setup failed');
      setLoading(false);
    }
  }

  return (
    <div className="container">
      <div className="card">
        <h1>初始化系统</h1>
        <p className="sub">创建第一个管理员账号并注册 Passkey。此步骤仅执行一次。</p>
        <label htmlFor="name">你的名字</label>
        <input
          id="name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Alice"
          maxLength={50}
        />
        {error && <p className="error">{error}</p>}
        <button disabled={!name.trim() || loading} onClick={handleSetup}>
          {loading ? '处理中…' : '注册 Passkey 并初始化'}
        </button>
      </div>
    </div>
  );
}
