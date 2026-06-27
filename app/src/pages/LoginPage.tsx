import { useState } from 'react';
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

  return (
    <div className="container">
      <div className="card">
        <h1>登录</h1>
        <p className="sub">使用 Passkey 登录{returnTo ? '后返回原页面' : ''}。</p>
        {error && <p className="error">{error}</p>}
        <button disabled={loading} onClick={handleLogin}>
          {loading ? '验证中…' : '使用 Passkey 登录'}
        </button>
        {registrationEnabled && (
          <p style={{ marginTop: '1rem' }}>
            还没有账号？ <Link to="/register">注册</Link>
          </p>
        )}
      </div>
    </div>
  );
}
