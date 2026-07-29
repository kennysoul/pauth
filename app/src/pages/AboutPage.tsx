import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type SystemState } from '../api';

export function AboutPage() {
  const [state, setState] = useState<SystemState | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<SystemState>('/api/system/state')
      .then(setState)
      .catch((e) => setError(e instanceof Error ? e.message : '加载失败'));
  }, []);

  return (
    <div className="container">
      <div className="card about-page">
        <header className="about-hero">
          <h1>Oauth KASS</h1>
          <p className="about-tagline">
            Oauth KASS is an internal identity and access management service
            for our organization. It authenticates users via WebAuthn Passkey,
            Google OAuth 2.0, and Microsoft OAuth 2.0, and provides
            OpenID Connect (OIDC) identity to internal applications.
          </p>
          <p className="about-links">
            <Link to="/privacy">Privacy Policy</Link>
            <span className="dot">·</span>
            <Link to="/terms">Terms of Service</Link>
            <span className="dot">·</span>
            <Link to="/login">Sign in</Link>
          </p>
        </header>

        <section className="about-section">
          <h2>Purpose of the application</h2>
          <p>
            Oauth KASS exists solely to authenticate members of our
            organization when they sign in to internal tools and services.
            It does not serve the public, does not run advertising, and
            does not collect data for any purpose other than authentication.
          </p>
          <ul>
            <li>Single sign-on (SSO) for internal web applications via OIDC.</li>
            <li>Passkey, Google, and Microsoft as supported sign-in methods.</li>
            <li>Per-user management of credentials and OAuth identity links.</li>
            <li>L1 (gateway forward-auth) and L2 (OAuth client) access roles.</li>
          </ul>
        </section>

        <section className="about-section">
          <h2>Data we handle</h2>
          <p>
            To perform sign-in, the service stores the minimum data required:
            a display name, an internal user identifier, a Passkey public
            key (never the private key), and — when the user chooses to link
            them — the identifier and email address returned by Google or
            Microsoft. Session cookies and audit records of security-related
            events are also retained. The full privacy policy is linked above.
          </p>
        </section>

        <section className="about-section">
          <h2>How Oauth KASS uses Google user data</h2>
          <p>
            When a user signs in with Google, the service receives a Google
            user identifier (sub) and the user's verified email address. This
            data is used only to authenticate the user and is never sold,
            shared with third parties, or used for advertising.
          </p>
        </section>

        <section className="about-section">
          <h2>Contact</h2>
          <p>
            Questions about Oauth KASS can be directed to the administrator
            of this deployment through your organization's internal channels.
          </p>
        </section>

        <p className="legal-footer about-footer">
          <Link to="/privacy">隐私政策</Link>
          <span className="legal-footer-sep">·</span>
          <Link to="/terms">服务条款</Link>
        </p>

        {error && <p className="error" style={{ marginTop: '1rem' }}>{error}</p>}
      </div>
    </div>
  );
}
