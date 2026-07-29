import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type SystemState } from '../api';

export function PrivacyPage() {
  const [state, setState] = useState<SystemState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated] = useState(() => new Date().toISOString().slice(0, 10));

  useEffect(() => {
    api<SystemState>('/api/system/state')
      .then(setState)
      .catch((e) => setError(e instanceof Error ? e.message : '加载失败'));
  }, []);

  return (
    <div className="container">
      <div className="card legal-page">
        <h1>隐私政策</h1>
        <p className="legal-meta">最后更新：{lastUpdated}</p>

        {error && <p className="error">无法加载服务信息：{error}</p>}
        {state && (
          <p className="legal-intro">
            本服务（<strong>{state.origin}</strong>，以下简称"我们"）尊重并保护所有使用本服务用户的个人隐私权。
            本政策说明我们如何收集、使用、储存和分享您的个人信息。
          </p>
        )}

        <h2>1. 我们收集的信息</h2>
        <p>为了向您提供身份认证服务，我们会在您使用本服务时收集以下信息：</p>
        <ul>
          <li>
            <strong>账户信息</strong>：由管理员分配的显示名称、用户 ID 以及用于第三方 OIDC 集成的电子邮箱地址。
          </li>
          <li>
            <strong>认证凭据</strong>：Passkey 公钥、第三方身份提供商（Google、Microsoft）返回的账户标识与电子邮箱。
          </li>
          <li>
            <strong>会话信息</strong>：登录会话标识、过期时间、登录 IP 地址和 User-Agent。
          </li>
          <li>
            <strong>审计日志</strong>：管理员操作、登录事件、OAuth 绑定/解绑等安全相关事件。
          </li>
        </ul>

        <h2>2. 我们如何使用信息</h2>
        <p>我们仅将收集的信息用于以下目的：</p>
        <ul>
          <li>提供、维护和改进身份认证服务；</li>
          <li>验证用户身份并保护账户安全；</li>
          <li>响应您的请求并提供客户支持；</li>
          <li>检测、预防和应对欺诈、安全事件或滥用行为；</li>
          <li>遵守适用的法律法规。</li>
        </ul>
        <p>我们<strong>不会</strong>将您的个人信息用于营销、广告或出售给任何第三方。</p>

        <h2>3. 第三方服务</h2>
        <p>本服务使用以下第三方身份提供商（仅在管理员已配置时启用）：</p>
        <ul>
          <li>
            <strong>Google OAuth</strong> — 当您选择"使用 Google 登录"或绑定 Google 账户时使用。
            Google 将按其自己的隐私政策处理您的数据：
            <a href="https://policies.google.com/privacy" target="_blank" rel="noopener noreferrer">Google 隐私政策</a>。
          </li>
          <li>
            <strong>Microsoft OAuth</strong> — 当您选择"使用 Microsoft 登录"或绑定 Microsoft 账户时使用。
            Microsoft 将按其自己的隐私政策处理您的数据：
            <a href="https://privacy.microsoft.com/" target="_blank" rel="noopener noreferrer">Microsoft 隐私政策</a>。
          </li>
        </ul>
        <p>本服务本身<strong>不</strong>将您的数据出售给第三方，也不会用于跨平台行为广告投放。</p>

        <h2>4. 数据的存储与安全</h2>
        <p>
          所有用户数据均存储在 Cloudflare D1（分布式关系数据库）中，部署在 Cloudflare 全球边缘网络。
          会话 Cookie 使用 HMAC-SHA-256 签名，并通过 HTTPS 传输。
          加密的备份（AES-256-GCM + PBKDF2 100,000 次迭代）仅由管理员手动触发，<strong>不</strong>包含根管理员账户的数据。
        </p>
        <p>我们采用业界标准的安全措施来保护您的信息，但没有任何系统能保证 100% 安全。</p>

        <h2>5. 用户权利</h2>
        <p>您对自己的个人信息享有以下权利：</p>
        <ul>
          <li>查看和修改您的显示名称和电子邮箱；</li>
          <li>删除您自己的 Passkey；</li>
          <li>解绑您关联的 Google 或 Microsoft 账户；</li>
          <li>请求删除您的账户（请联系管理员）。</li>
        </ul>
        <p>本服务<strong>不</strong>向加州 16 岁以下未成年人提供服务。如有相关疑虑，请联系管理员。</p>

        <h2>6. Cookie 使用</h2>
        <p>本服务使用以下 Cookie：</p>
        <ul>
          <li><code>sid</code> — 登录会话标识（HttpOnly、Secure）；</li>
          <li><code>setup_sid</code> — 首次安装时使用（HttpOnly、Secure）。</li>
        </ul>
        <p>本服务<strong>不</strong>使用任何广告或第三方追踪 Cookie。</p>

        <h2>7. 政策的变更</h2>
        <p>如果本隐私政策发生重大变更，我们会在此页面更新"最后更新"日期。建议您定期查看本政策。</p>

        <h2>8. 联系方式</h2>
        <p>如对本隐私政策有任何疑问，请通过您所在组织的内部渠道联系本服务的管理员。</p>

        <p className="legal-back">
          <Link to="/login">← 返回登录</Link>
        </p>
      </div>
    </div>
  );
}
