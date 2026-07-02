import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { startAuthentication } from '@simplewebauthn/browser';
import { api } from '../api';

type Props = {
  registrationEnabled: boolean;
};

export function LoginPage({ registrationEnabled }: Props) {
  const [searchParams] = useSearchParams();
  const returnTo = searchParams.get('return_to');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [googleEnabled, setGoogleEnabled] = useState(false);
  const [microsoftEnabled, setMicrosoftEnabled] = useState(false);

  useEffect(() => {
    const oauthError = searchParams.get('oauth_error');
    if (oauthError) setError(decodeURIComponent(oauthError));
  }, [searchParams]);

  useEffect(() => {
    api<{ enabled: boolean }>('/api/oauth/google/public-status')
      .then((s) => setGoogleEnabled(s.enabled))
      .catch(() => setGoogleEnabled(false));
    api<{ enabled: boolean }>('/api/oauth/microsoft/public-status')
      .then((s) => setMicrosoftEnabled(s.enabled))
      .catch(() => setMicrosoftEnabled(false));
  }, []);

  async function handleLogin() {
    setLoading(true);
    setError(null);
    try {
      const { options, challengeId } = await api<{
        options: Parameters<typeof startAuthentication>[0]['optionsJSON'];
        challengeId: string;
      }>('/api/login/options', { method: 'POST' });

      const authenticationResponse = await startAuthentication({ optionsJSON: options });

      const res = await fetch('/api/login/verify', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          challengeId,
          authenticationResponse,
          returnTo,
        }),
        redirect: 'follow',
      });

      if (res.redirected) {
        window.location.href = res.url;
        return;
      }

      const data = (await res.json()) as { error?: string; redirect?: string };
      if (!res.ok) {
        throw new Error(data.error ?? 'Login failed');
      }
      window.location.href = data.redirect ?? '/admin';
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Login failed');
      setLoading(false);
    }
  }

  function oauthLogin(provider: 'google' | 'microsoft') {
    const next = returnTo || '/admin';
    window.location.href = `/api/oauth/${provider}/start?mode=login&next=${encodeURIComponent(next)}`;
  }

  return (
    <div className="container">
      <div className="card">
        <h1>登录</h1>
        <p className="sub">使用 Passkey 或第三方账号登录{returnTo ? '后返回原页面' : ''}。</p>
        {error && <p className="error">{error}</p>}
        <button disabled={loading} onClick={handleLogin}>
          {loading ? '验证中…' : '使用 Passkey 登录'}
        </button>
        {(googleEnabled || microsoftEnabled) && (
          <div className="oauth-login-row">
            {googleEnabled && (
              <button type="button" className="secondary oauth-login-btn" onClick={() => oauthLogin('google')}>
                <img src="/img/google.svg" alt="" />
                使用 Google 登录
              </button>
            )}
            {microsoftEnabled && (
              <button type="button" className="secondary oauth-login-btn" onClick={() => oauthLogin('microsoft')}>
                <img src="/img/microsoft.svg" alt="" />
                使用 Microsoft 登录
              </button>
            )}
          </div>
        )}
        {registrationEnabled && (
          <p style={{ marginTop: '1rem' }}>
            还没有账号？ <Link to="/register">注册</Link>
          </p>
        )}
      </div>
    </div>
  );
}
