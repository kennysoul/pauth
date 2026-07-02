import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { startRegistration } from '@simplewebauthn/browser';
import { api, type InviteInfo } from '../api';

export function InvitePage() {
  const { token } = useParams<{ token: string }>();
  const [info, setInfo] = useState<InviteInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  useEffect(() => {
    if (!token) return;
    api<InviteInfo>(`/api/invite/${token}`)
      .then(setInfo)
      .catch((e) => setError(e instanceof Error ? e.message : 'Invalid invite'));
  }, [token]);

  async function handleRegister() {
    if (!token) return;
    setLoading(true);
    setError(null);
    try {
      await api(`/api/invite/${token}/begin`, { method: 'POST' });

      const { options, challengeId } = await api<{
        options: Parameters<typeof startRegistration>[0]['optionsJSON'];
        challengeId: string;
      }>(`/api/invite/${token}/passkey/options`, { method: 'POST' });

      const registrationResponse = await startRegistration({ optionsJSON: options });

      const result = await api<{ message: string }>(`/api/invite/${token}/passkey/verify`, {
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
          <h1>注册完成</h1>
          <p className="success">{done}</p>
          <Link to="/login" className="btn">
            前往登录
          </Link>
        </div>
      </div>
    );
  }

  if (error && !info) {
    return (
      <div className="container">
        <div className="card">
          <h1>邀请无效</h1>
          <p className="error">{error}</p>
        </div>
      </div>
    );
  }

  if (!info) {
    return (
      <div className="container">
        <p className="sub">加载中…</p>
      </div>
    );
  }

  return (
    <div className="container">
      <div className="card">
        <h1>完成注册</h1>
        <p className="sub">
          你好 {info.name}，请注册 Passkey 以激活账号。
        </p>
        {error && <p className="error">{error}</p>}
        <button disabled={loading} onClick={handleRegister}>
          {loading ? '处理中…' : '注册 Passkey'}
        </button>
      </div>
    </div>
  );
}
