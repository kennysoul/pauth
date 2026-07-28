import { useEffect, useRef, useState } from 'react';
import { api, type GoogleIntegration, type MicrosoftIntegration, type ValidateResult, type WebAuthIntegration } from '../../api';
import { useToast } from '../../components/useToast';

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
  const inputRef = useRef<HTMLInputElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);

  function toggle() {
    const input = inputRef.current;
    const btn = btnRef.current;
    if (!input || !btn) return;
    if (input.type === 'password') {
      input.type = 'text';
      btn.classList.add('is-visible');
    } else {
      input.type = 'password';
      btn.classList.remove('is-visible');
    }
  }

  return (
    <div className="secret-input-wrap">
      <input
        ref={inputRef}
        id={id}
        type="password"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={secretSet ? '********' : '未配置请填写 Client Secret'}
        autoComplete="new-password"
      />
      <button
        ref={btnRef}
        type="button"
        className="secret-visibility-btn"
        onClick={toggle}
        aria-label="显示 Secret"
        title="显示 Secret"
      >
        <svg className="icon-hide" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6z"></path>
          <circle cx="12" cy="12" r="3"></circle>
          <path d="M4 20L20 4"></path>
        </svg>
        <svg className="icon-show" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6z"></path>
          <circle cx="12" cy="12" r="3"></circle>
        </svg>
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

function IntegrationCardHead({
  title,
  desc,
  children,
}: {
  title: string;
  desc: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="settings-inline-head integration-card-head">
      <div>
        <div className="integration-title-row">
          <h3>{title}</h3>
          {children}
        </div>
        <p className="config-card-desc">{desc}</p>
      </div>
    </div>
  );
}

export function AdminIntegrationPage() {
  const { showToast, toastEl } = useToast();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [validatingGoogle, setValidatingGoogle] = useState(false);
  const [validatingMicrosoft, setValidatingMicrosoft] = useState(false);
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
      if (g.clientSecretSet && !gForm.clientSecret) {
        const cached = localStorage.getItem('pauth-google-secret');
        if (cached) gForm.clientSecret = cached;
      }
      if (m.clientSecretSet && !mForm.clientSecret) {
        const cached = localStorage.getItem('pauth-microsoft-secret');
        if (cached) mForm.clientSecret = cached;
      }
      // 预加载明文 secret（仅当后端有配置且前端 value 仍为空）
      const [gSecret, mSecret] = await Promise.all([
        g.clientSecretSet && !gForm.clientSecret
          ? api<{ clientSecret: string }>('/api/admin/integration/google/secret')
              .then((r) => r.clientSecret)
              .catch(() => '')
          : Promise.resolve(gForm.clientSecret),
        m.clientSecretSet && !mForm.clientSecret
          ? api<{ clientSecret: string }>('/api/admin/integration/microsoft/secret')
              .then((r) => r.clientSecret)
              .catch(() => '')
          : Promise.resolve(mForm.clientSecret),
      ]);
      gForm.clientSecret = gSecret;
      mForm.clientSecret = mSecret;
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
    setError(null);
    showToast('已恢复为上次保存的配置');
  }

  async function saveAll() {
    setSaving(true);
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
      const gForm = { ...toGoogleForm(gRes), clientSecret: google.clientSecret };
      const mForm = { ...toMicrosoftForm(mRes), clientSecret: microsoft.clientSecret };
      setGoogle(gForm);
      setMicrosoft(mForm);
      setBaseline((prev) => ({
        webauth: prev?.webauth ?? webauth,
        google: gForm,
        microsoft: mForm,
      }));
      showToast('集成配置已保存');
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存失败');
    } finally {
      setSaving(false);
    }
  }

  async function validateGoogle() {
    setValidatingGoogle(true);
    setError(null);
    try {
      const result = await api<ValidateResult>('/api/admin/integration/google/validate', {
        method: 'POST',
      });
      if (result.ok) {
        showToast(result.message || 'Google OAuth 配置验证通过');
      } else {
        setError(result.error || '验证失败');
        if (result.detail) {
          showToast(result.detail);
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : '验证请求失败');
    } finally {
      setValidatingGoogle(false);
    }
  }

  async function validateMicrosoft() {
    setValidatingMicrosoft(true);
    setError(null);
    try {
      const result = await api<ValidateResult>('/api/admin/integration/microsoft/validate', {
        method: 'POST',
      });
      if (result.ok) {
        showToast(result.message || 'Microsoft OAuth 配置验证通过');
      } else {
        setError(result.error || '验证失败');
        if (result.detail) {
          showToast(result.detail);
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : '验证请求失败');
    } finally {
      setValidatingMicrosoft(false);
    }
  }

  return (
    <>
      <div className="main-head">
        <div className="head-text">
          <h1 className="head-title">集成与安全</h1>
          <p className="head-sub">配置 Passkey、Google、Microsoft 登录参数。</p>
        </div>
        <div className="page-header-actions">
          <button
            type="button"
            className="btn"
            disabled={saving || loading || !baseline}
            onClick={resetForms}
          >
            重置
          </button>
          <button type="button" className="btn primary" disabled={saving || loading} onClick={saveAll}>
            {saving ? '保存中…' : '保存'}
          </button>
        </div>
      </div>

      <div className="admin-main-body">
        {loading ? (
          <p className="sub">加载中…</p>
        ) : (
          <>
            {error && <p className="error span-12">{error}</p>}

            <article className="card span-12 integration-card">
              <IntegrationCardHead
                title="WEBAUTH"
                desc="Passkey 运行参数，来自 wrangler/env，仅展示不可在此修改。"
              />
              <div className="integration-form-grid">
                <div className="config-field">
                  <label htmlFor="webauth-rp-id">RP_ID</label>
                  <input id="webauth-rp-id" readOnly value={webauth?.rpId ?? ''} />
                </div>
                <div className="config-field">
                  <label htmlFor="webauth-origin">ORIGIN</label>
                  <input id="webauth-origin" readOnly value={webauth?.origin ?? ''} />
                </div>
              </div>
              <p className="integration-meta">
                RP_NAME={webauth?.rpName ?? '—'} · 来源 {webauth?.source ?? 'wrangler'}
                {webauth?.cookieDomain ? ` · Cookie Domain=${webauth.cookieDomain}` : ''}
              </p>
            </article>

            <article className="card span-12 integration-card">
              <IntegrationCardHead
                title="Google OAuth"
                desc="Client ID 与 Client Secret 为必填；Redirect URI 可选。"
              >
                <button
                  type="button"
                  className="validate-chip"
                  disabled={validatingGoogle || !google.enabled}
                  onClick={validateGoogle}
                >
                  {validatingGoogle ? '…' : '验证'}
                </button>
              </IntegrationCardHead>
              <div className="integration-form-grid">
                <div className="config-field">
                  <label htmlFor="google-client-id">Client ID</label>
                  <input
                    id="google-client-id"
                    value={google.clientId}
                    onChange={(e) => setGoogle({ ...google, clientId: e.target.value })}
                  />
                </div>
                <div className="config-field">
                  <label htmlFor="google-client-secret">Client Secret</label>
                  <SecretField
                    id="google-client-secret"
                    value={google.clientSecret}
                     onChange={(v) => { setGoogle({ ...google, clientSecret: v }); localStorage.setItem('pauth-google-secret', v); }}
                    secretSet={google.clientSecretSet}
                  />
                </div>
                <div className="config-field integration-field-full">
                  <label htmlFor="google-redirect">Redirect URI</label>
                  <input
                    id="google-redirect"
                    value={google.redirectUri}
                    onChange={(e) => setGoogle({ ...google, redirectUri: e.target.value })}
                    placeholder="留空则按当前访问域名自动推导"
                  />
                </div>
              </div>
              {google.enabled && (
                <p className="integration-meta">
                  Secret {google.clientSecretSet ? '已配置（默认掩码显示）' : '未配置'}
                </p>
              )}
            </article>

            <article className="card span-12 integration-card">
              <IntegrationCardHead
                title="Microsoft"
                desc="在本页面配置 Microsoft 登录，不依赖 wrangler/env。"
              >
                <button
                  type="button"
                  className="validate-chip"
                  disabled={validatingMicrosoft || !microsoft.enabled}
                  onClick={validateMicrosoft}
                >
                  {validatingMicrosoft ? '…' : '验证'}
                </button>
              </IntegrationCardHead>
              <div className="integration-form-grid">
                <div className="config-field">
                  <label htmlFor="ms-tenant">Tenant ID</label>
                  <input
                    id="ms-tenant"
                    value={microsoft.tenantId}
                    onChange={(e) => setMicrosoft({ ...microsoft, tenantId: e.target.value })}
                    placeholder="common"
                  />
                </div>
                <div className="config-field">
                  <label htmlFor="ms-client-id">Client ID</label>
                  <input
                    id="ms-client-id"
                    value={microsoft.clientId}
                    onChange={(e) => setMicrosoft({ ...microsoft, clientId: e.target.value })}
                  />
                </div>
                <div className="config-field">
                  <label htmlFor="ms-client-secret">Client Secret</label>
                  <SecretField
                    id="ms-client-secret"
                    value={microsoft.clientSecret}
                    onChange={(v) => { setMicrosoft({ ...microsoft, clientSecret: v }); localStorage.setItem('pauth-microsoft-secret', v); }}
                    secretSet={microsoft.clientSecretSet}
                  />
                </div>
                <div className="config-field">
                  <label htmlFor="ms-redirect">Redirect URI</label>
                  <input
                    id="ms-redirect"
                    value={microsoft.redirectUri}
                    onChange={(e) => setMicrosoft({ ...microsoft, redirectUri: e.target.value })}
                    placeholder="留空则按当前访问域名自动推导"
                  />
                </div>
              </div>
              {microsoft.enabled && (
                <p className="integration-meta">
                  Secret {microsoft.clientSecretSet ? '已配置（默认掩码显示）' : '未配置'}
                </p>
              )}
            </article>
          </>
        )}
      </div>
      {toastEl}
    </>
  );
}
