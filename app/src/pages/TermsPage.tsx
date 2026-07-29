import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type SystemState } from '../api';

export function TermsPage() {
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
        <h1>服务条款</h1>
        <p className="legal-meta">最后更新：{lastUpdated}</p>

        {error && <p className="error">无法加载服务信息：{error}</p>}
        {state && (
          <p className="legal-intro">
            本服务（<strong>{state.origin}</strong>，以下简称"本服务"）由您的组织运营并提供。
            使用本服务即表示您同意遵守以下条款。
          </p>
        )}

        <h2>1. 服务说明</h2>
        <p>
          本服务是一个基于 Web 的身份认证与访问管理服务，使用 Passkey（基于 WebAuthn 标准的无密码身份验证）、
          Google OAuth 2.0 和 Microsoft OAuth 2.0 作为登录方式。
          本服务还通过标准 OpenID Connect (OIDC) 协议向第三方应用提供身份验证。
        </p>

        <h2>2. 账户与访问</h2>
        <ul>
          <li>本服务<strong>不</strong>接受公开自助注册。账户由管理员手动创建并分配。</li>
          <li>每个账户最多支持 1 个 Google 身份、1 个 Microsoft 身份，以及任意数量的 Passkey。</li>
          <li>账户仅供获得授权的用户使用；不得与他人共享凭据。</li>
          <li>用户应妥善保管自己的设备与登录凭据；管理员不会以明文形式查看 Passkey 私钥。</li>
        </ul>

        <h2>3. 可接受的使用</h2>
        <p>您同意<strong>不</strong>：</p>
        <ul>
          <li>利用本服务从事任何非法、欺诈或侵权活动；</li>
          <li>尝试探测、扫描或测试本服务的安全性，绕过任何安全措施；</li>
          <li>向本服务上传恶意代码、病毒或任何旨在损害本服务的内容；</li>
          <li>以任何方式干扰或破坏本服务的完整性或性能。</li>
        </ul>

        <h2>4. 第三方服务</h2>
        <p>本服务依赖以下第三方服务：</p>
        <ul>
          <li><strong>Cloudflare</strong>（Workers / D1 / KV）— 托管与数据存储</li>
          <li><strong>Google OAuth</strong>（仅在管理员配置时启用）</li>
          <li><strong>Microsoft OAuth</strong>（仅在管理员配置时启用）</li>
        </ul>
        <p>这些第三方服务可能按其各自的条款与隐私政策处理您的数据。本服务不对第三方服务的可用性或行为承担责任。</p>

        <h2>5. 服务的可用性</h2>
        <p>本服务按"现状"提供。我们努力保持高可用性，但不对不间断访问作出任何明示或暗示的保证。我们保留在通知或未通知的情况下进行维护、升级或暂停服务的权利。</p>

        <h2>6. 知识产权</h2>
        <p>本服务的源代码、设计、品牌与文档由其所有者拥有，受相关法律法规保护。未经授权，不得复制、修改、再分发或用于商业用途。</p>

        <h2>7. 责任限制</h2>
        <p>在法律允许的最大范围内，本服务对因使用或无法使用本服务而造成的任何间接、偶发、特殊、惩罚性或后果性损害不承担责任，包括但不限于数据丢失、业务中断或利润损失。</p>

        <h2>8. 条款的变更</h2>
        <p>我们保留根据需要修改本服务条款的权利。重大变更会通过本页面更新"最后更新"日期。继续使用本服务即表示您接受修订后的条款。</p>

        <h2>9. 适用法律</h2>
        <p>本服务条款的解释、效力及解释均适用您所在组织所在司法管辖区的法律。</p>

        <h2>10. 联系方式</h2>
        <p>如对本服务条款有任何疑问，请通过您所在组织的内部渠道联系本服务的管理员。</p>

        <p className="legal-back">
          <Link to="/login">← 返回登录</Link>
        </p>
      </div>
    </div>
  );
}
