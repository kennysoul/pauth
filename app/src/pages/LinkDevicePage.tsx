import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { startRegistration } from '@simplewebauthn/browser';
import { api } from '../api';

export function LinkDevicePage() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get('t')?.trim() || '';
  const [name, setName] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  useEffect(() => {
    if (!token) {
      setError('链接无效');
      return;
    }
    api<{ name: string }>(`/api/passkey-delegate/${token}`)
      .then((info) => setName(info.name))
      .catch((e) => setError(e instanceof Error ? e.message : '链接已过期或无效'));
  }, [token]);

  async function handleRegister() {
    if (!token) return;
    setLoading(true);
    setError(null);
    try {
      const { options, challengeId } = await api<{
        options: Parameters<typeof startRegistration>[0]['optionsJSON'];
        challengeId: string;
      }>(`/api/passkey-delegate/${token}/options`, { method: 'POST' });

      const registrationResponse = await startRegistration({ optionsJSON: options });

      const result = await api<{ message: string }>(`/api/passkey-delegate/${token}/verify`, {
        method: 'POST',
        body: JSON.stringify({ challengeId, registrationResponse }),
      });

      setDone(result.message);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Registration failed');
    } finally {
      setLoading(false);
    }
  }

  if (done) {
    return (
      <div className="container">
        <div className="card">
          <h1>完成</h1>
          <p className="success">{done}</p>
          <Link to="/login" className="btn">
            前往登录
          </Link>
        </div>
      </div>
    );
  }

  if (error && !name) {
    return (
      <div className="container">
        <div className="card">
          <h1>链接无效</h1>
          <p className="error">{error}</p>
        </div>
      </div>
    );
  }

  if (!name) {
    return (
      <div className="container">
        <p className="sub">加载中…</p>
      </div>
    );
  }

  return (
    <div className="container">
      <div className="card">
        <h1>添加 Passkey</h1>
        <p className="sub">为账号 {name} 注册 Passkey。</p>
        {error && <p className="error">{error}</p>}
        <button disabled={loading} onClick={handleRegister}>
          {loading ? '处理中…' : '注册 Passkey'}
        </button>
      </div>
    </div>
  );
}
