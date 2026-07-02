import { useEffect, useState } from 'react';
import { api, type GoogleIntegration, type MicrosoftIntegration, type WebAuthIntegration } from '../../api';

type GoogleForm = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  clientSecretSet: boolean;
  enabled: boolean;
};

type MicrosoftForm = {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  clientSecretSet: boolean;
  enabled: boolean;
};

type Baseline = {
  webauth: WebAuthIntegration | null;
  google: GoogleForm;
  microsoft: MicrosoftForm;
};

function SecretField({
  id,
  value,
  onChange,
  secretSet,
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  secretSet: boolean;
}) {
  const [visible, setVisible] = useState(false);
  return (
    <div className="secret-input-wrap">
      <input
        id={id}
        type={visible ? 'text' : 'password'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={secretSet ? '********' : '未配置请填写 Client Secret'}
        autoComplete="new-password"
      />
      <button
        type="button"
        className={`icon-btn eye-btn${visible ? ' is-visible' : ''}`}
        onClick={() => setVisible((v) => !v)}
        aria-label={visible ? '隐藏 Secret' : '显示 Secret'}
        title={visible ? '隐藏 Secret' : '显示 Secret'}
      >
        {visible ? (
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path
              d="M3 3l18 18M10.58 10.58A3 3 0 0 0 12 15a3 3 0 0 0 2.42-4.42M9.9 4.24A10.94 10.94 0 0 1 12 4c7 0 10 7 10 7a16.2 16.2 0 0 1-3.17 4.19M6.12 6.12A16.2 16.2 0 0 0 2 12s3 7 10 7a10.94 10.94 0 0 0 4.24-.9"
              stroke="currentColor"
              strokeWidth="1.75"
              strokeLinecap="round"
            />
          </svg>
        ) : (
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path
              d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"
              stroke="currentColor"
              strokeWidth="1.75"
            />
            <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.75" />
          </svg>
        )}
      </button>
    </div>
  );
}

function toGoogleForm(g: GoogleIntegration): GoogleForm {
  return {
    clientId: g.clientId,
    clientSecret: '',
    redirectUri: g.redirectUri,
    clientSecretSet: g.clientSecretSet,
    enabled: g.enabled,
  };
}

function toMicrosoftForm(m: MicrosoftIntegration): MicrosoftForm {
  return {
    tenantId: m.tenantId || 'common',
    clientId: m.clientId,
    clientSecret: '',
    redirectUri: m.redirectUri,
    clientSecretSet: m.clientSecretSet,
    enabled: m.enabled,
  };
}

export function AdminIntegrationPage() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [webauth, setWebauth] = useState<WebAuthIntegration | null>(null);
  const [google, setGoogle] = useState<GoogleForm>({
    clientId: '',
    clientSecret: '',
    redirectUri: '',
    clientSecretSet: false,
    enabled: false,
  });
  const [microsoft, setMicrosoft] = useState<MicrosoftForm>({
    tenantId: 'common',
    clientId: '',
    clientSecret: '',
    redirectUri: '',
    clientSecretSet: false,
    enabled: false,
  });
  const [baseline, setBaseline] = useState<Baseline | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const [w, g, m] = await Promise.all([
        api<WebAuthIntegration>('/api/admin/integration/webauth'),
        api<GoogleIntegration>('/api/admin/integration/google'),
        api<MicrosoftIntegration>('/api/admin/integration/microsoft'),
      ]);
      const gForm = toGoogleForm(g);
      const mForm = toMicrosoftForm(m);
      setWebauth(w);
      setGoogle(gForm);
      setMicrosoft(mForm);
      setBaseline({ webauth: w, google: gForm, microsoft: mForm });
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载失败');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  function resetForms() {
    if (!baseline) return;
    setGoogle({ ...baseline.google, clientSecret: '' });
    setMicrosoft({ ...baseline.microsoft, clientSecret: '' });
    setMessage(null);
    setError(null);
  }

  async function saveAll() {
    setSaving(true);
    setMessage(null);
    setError(null);
    try {
      const [gRes, mRes] = await Promise.all([
        api<GoogleIntegration & { ok: boolean }>('/api/admin/integration/google', {
          method: 'POST',
          body: JSON.stringify({
            clientId: google.clientId,
            clientSecret: google.clientSecret,
            redirectUri: google.redirectUri,
          }),
        }),
        api<MicrosoftIntegration & { ok: boolean }>('/api/admin/integration/microsoft', {
          method: 'POST',
          body: JSON.stringify({
            tenantId: microsoft.tenantId,
            clientId: microsoft.clientId,
            clientSecret: microsoft.clientSecret,
            redirectUri: microsoft.redirectUri,
          }),
        }),
      ]);
      const gForm = toGoogleForm(gRes);
      const mForm = toMicrosoftForm(mRes);
      setGoogle(gForm);
      setMicrosoft(mForm);
      setBaseline((prev) => ({
        webauth: prev?.webauth ?? webauth,
        google: gForm,
        microsoft: mForm,
      }));
      setMessage('集成配置已保存');
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存失败');
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <p className="sub">加载中…</p>;

  const googleHint = google.enabled
    ? `Google 当前状态：已启用，${google.clientSecretSet ? '已配置 Secret（默认掩码显示）' : '未配置 Secret'}`
    : 'Google 当前状态：未启用';
  const microsoftHint = microsoft.enabled
    ? `Microsoft 当前状态：已启用，${microsoft.clientSecretSet ? '已配置 Secret（默认掩码显示）' : '未配置 Secret'}`
    : 'Microsoft 当前状态：未启用';

  return (
    <>
      <div className="page-header">
        <div>
          <h1>集成与安全</h1>
          <p className="sub integration-subtitle">配置 WEBAUTH、Google、Microsoft 登录。</p>
        </div>
        <div className="page-header-actions">
          <button type="button" className="secondary" disabled={saving || !baseline} onClick={resetForms}>
            重置
          </button>
          <button type="button" disabled={saving} onClick={saveAll}>
            {saving ? '保存中…' : '保存'}
          </button>
        </div>
      </div>

      {message && <p className="success">{message}</p>}
      {error && <p className="error">{error}</p>}

      <div className="integration-stack">
        <article className="card integration-card">
          <h3>WEBAUTH</h3>
          <p className="sub">
            用于 Passkey 登录；此处仅展示当前运行配置（来自 wrangler/env），不在页面内修改或应用。
          </p>
          <div className="field-grid two">
            <div className="field">
              <label htmlFor="webauth-rp-id">RP_ID</label>
              <input id="webauth-rp-id" readOnly value={webauth?.rpId ?? ''} />
            </div>
            <div className="field">
              <label htmlFor="webauth-origin">ORIGIN</label>
              <input id="webauth-origin" readOnly value={webauth?.origin ?? ''} />
            </div>
          </div>
          <p className="hint">
            当前运行值：RP_NAME={webauth?.rpName ?? '—'}；来源 {webauth?.source ?? 'wrangler'} 运行配置。
            {webauth?.cookieDomain ? ` Cookie Domain=${webauth.cookieDomain}。` : ''}
          </p>
        </article>

        <article className="card integration-card">
          <h3>Google OAuth</h3>
          <p className="sub">Client ID 与 Client Secret 为必填；Redirect URI 为可选。</p>
          <div className="field-grid">
            <div className="field">
              <label htmlFor="google-client-id">Client ID</label>
              <input
                id="google-client-id"
                value={google.clientId}
                onChange={(e) => setGoogle({ ...google, clientId: e.target.value })}
              />
            </div>
            <div className="field">
              <label htmlFor="google-client-secret">Client Secret</label>
              <SecretField
                id="google-client-secret"
                value={google.clientSecret}
                onChange={(v) => setGoogle({ ...google, clientSecret: v })}
                secretSet={google.clientSecretSet}
              />
            </div>
            <div className="field">
              <label htmlFor="google-redirect">Redirect URI</label>
              <input
                id="google-redirect"
                value={google.redirectUri}
                onChange={(e) => setGoogle({ ...google, redirectUri: e.target.value })}
                placeholder="留空则按当前访问域名自动推导"
              />
            </div>
          </div>
          <p className="hint">{googleHint}</p>
        </article>

        <article className="card integration-card">
          <h3>Microsoft</h3>
          <p className="sub">仅通过本页面配置 Microsoft 登录（不依赖 wrangler/env）。</p>
          <div className="field-grid two">
            <div className="field">
              <label htmlFor="ms-tenant">Tenant ID</label>
              <input
                id="ms-tenant"
                value={microsoft.tenantId}
                onChange={(e) => setMicrosoft({ ...microsoft, tenantId: e.target.value })}
                placeholder="common"
              />
            </div>
            <div className="field">
              <label htmlFor="ms-client-id">Client ID</label>
              <input
                id="ms-client-id"
                value={microsoft.clientId}
                onChange={(e) => setMicrosoft({ ...microsoft, clientId: e.target.value })}
              />
            </div>
            <div className="field">
              <label htmlFor="ms-client-secret">Client Secret</label>
              <SecretField
                id="ms-client-secret"
                value={microsoft.clientSecret}
                onChange={(v) => setMicrosoft({ ...microsoft, clientSecret: v })}
                secretSet={microsoft.clientSecretSet}
              />
            </div>
            <div className="field">
              <label htmlFor="ms-redirect">Redirect URI（可选）</label>
              <input
                id="ms-redirect"
                value={microsoft.redirectUri}
                onChange={(e) => setMicrosoft({ ...microsoft, redirectUri: e.target.value })}
                placeholder="留空则按当前访问域名自动推导"
              />
            </div>
          </div>
          <p className="hint">{microsoftHint}</p>
        </article>
      </div>
    </>
  );
}
