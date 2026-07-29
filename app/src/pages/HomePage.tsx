import { useState } from 'react';
import { Link } from 'react-router-dom';
import { startAuthentication } from '@simplewebauthn/browser';
import { api } from '../api';

const BRAND_RED = '#c8202f';

function BrandLogo() {
  // Round badge: white outer ring, red interior, OAUTH/AUTH around the ring, A in the center, crosshatch behind.
  return (
    <svg
      className="home-logo-svg"
      viewBox="0 0 200 200"
      xmlns="http://www.w3.org/2000/svg"
      aria-label="Oauth KASS logo"
    >
      <defs>
        {/* Top arc (OAUTH, upper half) */}
        <path
          id="home-logo-arc-top"
          d="M 30 100 A 70 70 0 0 1 170 100"
          fill="none"
        />
        {/* Bottom arc (AUTH, lower half — reversed) */}
        <path
          id="home-logo-arc-bottom"
          d="M 170 100 A 70 70 0 0 1 30 100"
          fill="none"
        />
      </defs>

      {/* White outer ring */}
      <circle cx="100" cy="100" r="92" fill="#ffffff" />
      {/* Red disk */}
      <circle cx="100" cy="100" r="86" fill={BRAND_RED} />
      {/* Inner thin red ring */}
      <circle
        cx="100"
        cy="100"
        r="78"
        fill="none"
        stroke="#ffffff"
        strokeWidth="1.5"
        opacity="0.55"
      />

      {/* Crosshatch behind the A */}
      <g stroke="#ffffff" strokeWidth="0.6" opacity="0.35">
        {Array.from({ length: 9 }).map((_, i) => (
          <line key={`d1-${i}`} x1={56 + i * 8} y1="60" x2={76 + i * 8} y2="140" />
        ))}
        {Array.from({ length: 9 }).map((_, i) => (
          <line key={`d2-${i}`} x1={60 + i * 8} y1="60" x2={80 + i * 8} y2="140" />
        ))}
        {Array.from({ length: 9 }).map((_, i) => (
          <line key={`u1-${i}`} x1={116 + i * 8} y1="60" x2={96 + i * 8} y2="140" />
        ))}
        {Array.from({ length: 9 }).map((_, i) => (
          <line key={`u2-${i}`} x1={120 + i * 8} y1="60" x2={100 + i * 8} y2="140" />
        ))}
      </g>

      {/* Curved text around the ring */}
      <text
        fill="#ffffff"
        fontFamily="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
        fontSize="15"
        fontWeight="700"
        letterSpacing="3"
      >
        <textPath href="#home-logo-arc-top" startOffset="50%" textAnchor="middle">
          OAUTH
        </textPath>
      </text>
      <text
        fill="#ffffff"
        fontFamily="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
        fontSize="15"
        fontWeight="700"
        letterSpacing="3"
      >
        <textPath href="#home-logo-arc-bottom" startOffset="50%" textAnchor="middle">
          AUTH
        </textPath>
      </text>

      {/* Center A */}
      <text
        x="100"
        y="138"
        fill="#ffffff"
        fontFamily="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
        fontSize="98"
        fontWeight="800"
        textAnchor="middle"
        letterSpacing="-2"
      >
        A
      </text>
    </svg>
  );
}

export function HomePage() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handlePasskeyLogin() {
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
        body: JSON.stringify({ challengeId, authenticationResponse }),
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
      window.location.href = data.redirect ?? '/me';
    } catch (e) {
      const raw = e instanceof Error ? e.message : 'Login failed';
      if (raw.includes('timed out') || raw.includes('not allowed') || raw.includes('NotAllowedError')) {
        setError('你已取消 Passkey 登录');
      } else {
        setError(raw);
      }
      setLoading(false);
    }
  }

  function oauthLogin(provider: 'google' | 'microsoft') {
    window.location.href = `/api/oauth/${provider}/start?mode=login&next=${encodeURIComponent('/me')}`;
  }

  return (
    <div className="container">
      <div className="card home-page-card">
        <BrandLogo />

        <h1 className="home-title">Oauth KASS</h1>
        <p className="home-tagline">Oauth KASS – 内部身份认证服务</p>

        {error && <p className="home-error">{error}</p>}

        <div className="home-buttons">
          <button
            type="button"
            className="home-btn home-btn-passkey"
            disabled={loading}
            onClick={handlePasskeyLogin}
          >
            {loading ? '验证中…' : '使用 Passkey 登录'}
          </button>
          <button
            type="button"
            className="home-btn home-btn-google"
            onClick={() => oauthLogin('google')}
          >
            <img src="/img/google.svg" alt="" />
            使用 Google 登录 / 注册
          </button>
          <button
            type="button"
            className="home-btn home-btn-microsoft"
            onClick={() => oauthLogin('microsoft')}
          >
            <img src="/img/microsoft.svg" alt="" />
            使用 Microsoft 登录 / 注册
          </button>
        </div>

        <p className="home-foot">
          <Link to="/privacy">隐私政策</Link>
          <span className="home-foot-sep">·</span>
          <Link to="/terms">服务条款</Link>
        </p>
      </div>
    </div>
  );
}
