import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { startRegistration } from '@simplewebauthn/browser';
import { api, type CompleteInfo } from '../api';

export function CompletePage() {
  const { token } = useParams<{ token: string }>();
  const navigate = useNavigate();
  const [info, setInfo] = useState<CompleteInfo | null>(null);
  const [expired, setExpired] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) return;
    api<CompleteInfo>(`/api/complete/${token}`)
      .then(setInfo)
      .catch((e) => {
        setExpired(true);
        setError(e instanceof Error ? e.message : '已失效');
      });
  }, [token]);

  async function handleActivatePasskey() {
    if (!token) return;
    setLoading(true);
    setError(null);
    try {
      const { options, challengeId } = await api<{
        options: Parameters<typeof startRegistration>[0]['optionsJSON'];
        challengeId: string;
      }>(`/api/complete/${token}/passkey/options`, { method: 'POST' });

      const registrationResponse = await startRegistration({ optionsJSON: options });

      await api(`/api/complete/${token}/passkey/verify`, {
        method: 'POST',
        body: JSON.stringify({ challengeId, registrationResponse }),
      });

      navigate('/me');
    } catch (e) {
      const raw = e instanceof Error ? e.message : '';
      if (raw.includes('timed out') || raw.includes('not allowed') || raw.includes('NotAllowedError')) {
        setError('你已取消passkey激活');
      } else if (raw.includes('已失效') || raw.includes('exhausted') || raw.includes('expired')) {
        setExpired(true);
        setError(raw);
      } else {
        setError(raw || '激活失败');
      }
    } finally {
      setLoading(false);
    }
  }

  function startOAuth(provider: 'google' | 'microsoft') {
    if (!token) return;
    window.location.href = `/api/oauth/${provider}/start?mode=register&complete_token=${encodeURIComponent(token)}`;
  }

  if (expired) {
    return (
      <div className="container">
        <div className="card">
          <h1>链接已失效</h1>
          <p className="error">{error ?? '请让管理员重新生成激活链接'}</p>
        </div>
      </div>
    );
  }

  if (!info) {
    return (
      <div className="container">
        <div className="card">
          <p className="sub">加载中…</p>
        </div>
      </div>
    );
  }

  return (
    <div className="container">
      <div className="card">
        <h1>账户激活</h1>
        <p className="sub">
          你好 {info.name}，请选择以下任一方式完成激活。
        </p>
        {error && <p className="error">{error}</p>}
        <button
          type="button"
          className="primary"
          disabled={loading}
          onClick={handleActivatePasskey}
          style={{ width: '100%' }}
        >
          {loading ? '处理中…' : '注册 Passkey 完成激活'}
        </button>
        <div className="oauth-login-row">
          <button type="button" className="secondary oauth-login-btn" onClick={() => startOAuth('google')}>
            <img src="/img/google.svg" alt="" />
            使用 Google 完成激活
          </button>
          <button type="button" className="secondary oauth-login-btn" onClick={() => startOAuth('microsoft')}>
            <img src="/img/microsoft.svg" alt="" />
            使用 Microsoft 完成激活
          </button>
        </div>
      </div>
    </div>
  );
}