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
      <div className="card home-page">
        <h1>Oauth KASS</h1>
        <p className="home-tagline">
          基于 Passkey 的无密码身份认证服务
        </p>

        <section className="home-section">
          <h2>这是什么</h2>
          <p>
            <strong>Oauth KASS</strong> 是一个面向<strong>内部团队</strong>使用的身份认证服务。
            使用业界标准的 <strong>Passkey</strong>（WebAuthn）作为主要登录方式，
            同时支持通过 <strong>Google</strong> 和 <strong>Microsoft</strong> 账号进行身份认证。
            本服务不向公众开放，所有账户由管理员手动创建并分配。
          </p>
        </section>

        <section className="home-section">
          <h2>服务用途</h2>
          <p>本服务用于：</p>
          <ul>
            <li>为内部应用提供统一的用户身份认证（基于 OpenID Connect 协议）；</li>
            <li>在多个内部网站之间实现单点登录（SSO）；</li>
            <li>通过 Passkey、 Google OAuth、 Microsoft OAuth 三种方式登录；</li>
            <li>管理用户身份验证凭据、第三方账号关联与权限（L1 / L2 访问）。</li>
          </ul>
          <p>
            本服务<strong>不</strong>用于：公开注册、营销活动、社交网络、内容分发、广告投放、
            支付处理或任何与上述无关的功能。
          </p>
        </section>

        <section className="home-section">
          <h2>可用的登录方式</h2>
          <ul>
            <li><strong>Passkey</strong>：使用本设备（指纹、面容或硬件安全密钥）登录，无需密码；</li>
            <li><strong>Google</strong>：使用 Google 账号登录（需管理员配置）；</li>
            <li><strong>Microsoft</strong>：使用 Microsoft 账号登录（需管理员配置）。</li>
          </ul>
        </section>

        <section className="home-section">
          <h2>数据与隐私</h2>
          <p>
            本服务仅收集为完成身份认证所必需的信息（账户标识、Passkey 公钥、第三方账号标识、会话状态）。
            不会收集用于广告或营销目的的信息，也不会向第三方出售数据。
            完整说明请参阅 <Link to="/privacy">隐私政策</Link>。
          </p>
        </section>

        <div className="home-actions">
          {state && state.state === 'NEEDS_SETUP' ? (
            <Link to="/setup" className="btn primary home-cta">首次安装（设置 root 管理员）</Link>
          ) : (
            <Link to="/login" className="btn primary home-cta">前往登录</Link>
          )}
        </div>

        <p className="legal-footer">
          <Link to="/privacy">隐私政策</Link>
          <span className="legal-footer-sep">·</span>
          <Link to="/terms">服务条款</Link>
        </p>

        {error && <p className="error" style={{ marginTop: '1rem' }}>{error}</p>}
      </div>
    </div>
  );
}
