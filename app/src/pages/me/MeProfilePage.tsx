import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { startRegistration } from '@simplewebauthn/browser';
import { api, type Me, type MeOAuthInfo } from '../../api';
import { useToast } from '../../components/useToast';
import { useConfirm } from '../../components/ConfirmProvider';
import { AnchoredModal } from '../../components/AnchoredModal';

type OAuthProvider = 'google' | 'microsoft';

type MePasskey = {
  id: string;
  credentialId: string;
  deviceType: string | null;
  backedUp: boolean;
  createdAt: string;
  lastUsedAt: string | null;
};

function PasskeyIcon({ linked }: { linked: boolean }) {
  return <span className={`icon-passkey ${linked ? 'on' : 'off'}`} aria-hidden="true" />;
}

function ProviderIcon({ provider, linked }: { provider: OAuthProvider; linked: boolean }) {
  const src = provider === 'google' ? '/img/google.svg' : '/img/microsoft.svg';
  const alt = provider === 'google' ? 'Google' : 'Microsoft';
  const cls = provider === 'google' ? 'icon-google' : 'icon-microsoft';
  return <img className={`${cls} ${linked ? 'on' : 'off'}`} src={src} alt={alt} />;
}

function formatDate(value: string) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value.slice(0, 16) || value;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const h = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  return `${y}-${m}-${day} ${h}:${min}`;
}

export function MeProfilePage() {
  const { showToast, toastEl } = useToast();
  const confirm = useConfirm();
  const [searchParams, setSearchParams] = useSearchParams();

  const [user, setUser] = useState<Me | null>(null);
  const [passkeys, setPasskeys] = useState<MePasskey[]>([]);
  const [oauthInfo, setOauthInfo] = useState<MeOAuthInfo | null>(null);
  const [loading, setLoading] = useState(true);

  const [nameInput, setNameInput] = useState('');
  const [emailInput, setEmailInput] = useState('');
  const [saving, setSaving] = useState(false);

  const [pkModalOpen, setPkModalOpen] = useState(false);
  const [pkBusy, setPkBusy] = useState(false);

  const [oauthModalProvider, setOauthModalProvider] = useState<OAuthProvider | null>(null);
  const [oauthBusy, setOAuthBusy] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const [u, pks, oauth] = await Promise.all([
        api<Me>('/api/me'),
        api<MePasskey[]>('/api/me/passkeys'),
        api<MeOAuthInfo>('/api/me/oauth'),
      ]);
      setUser(u);
      setPasskeys(pks);
      setOauthInfo(oauth);
      setNameInput(u.name);
      setEmailInput(u.email);
    } catch (e) {
      showToast(e instanceof Error ? e.message : '加载失败');
      if (e instanceof Error && e.message.includes('401')) {
        window.location.href = '/login';
      }
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  useEffect(() => {
    const oauth = searchParams.get('oauth');
    const oauthError = searchParams.get('oauth_error');
    if (oauthError) {
      showToast(decodeURIComponent(oauthError));
      setSearchParams({}, { replace: true });
      load();
      return;
    }
    if (oauth === 'google_bound' || oauth === 'microsoft_bound') {
      showToast(oauth === 'google_bound' ? 'Google 已关联' : 'Microsoft 已关联');
      setSearchParams({}, { replace: true });
      load();
    }
  }, [searchParams, setSearchParams]);

  async function saveName() {
    const name = nameInput.trim();
    if (!name) return;
    setSaving(true);
    try {
      await api('/api/me/name', { method: 'PUT', body: JSON.stringify({ name }) });
      showToast('名字已更新');
      load();
    } catch (e) {
      showToast(e instanceof Error ? e.message : '更新失败');
    } finally {
      setSaving(false);
    }
  }

  async function saveEmail() {
    const email = emailInput.trim();
    if (!email) return;
    setSaving(true);
    try {
      await api('/api/me/email', { method: 'PUT', body: JSON.stringify({ email }) });
      showToast('邮箱已更新');
      load();
    } catch (e) {
      showToast(e instanceof Error ? e.message : '更新失败');
    } finally {
      setSaving(false);
    }
  }

  async function addPasskey() {
    setPkBusy(true);
    try {
      const { options, challengeId } = await api<{
        options: Parameters<typeof startRegistration>[0]['optionsJSON'];
        challengeId: string;
      }>('/api/me/passkeys/options', { method: 'POST' });

      const registrationResponse = await startRegistration({ optionsJSON: options });

      await api<{ ok: boolean }>('/api/me/passkeys/verify', {
        method: 'POST',
        body: JSON.stringify({ challengeId, registrationResponse }),
      });

      showToast('Passkey 已添加');
      load();
    } catch (e) {
      const raw = e instanceof Error ? e.message : '';
      if (raw.includes('timed out') || raw.includes('not allowed') || raw.includes('NotAllowedError')) {
        showToast('你已取消添加 Passkey');
      } else {
        showToast(raw || '添加失败');
      }
    } finally {
      setPkBusy(false);
    }
  }

  async function deletePasskey(id: string) {
    const ok = await confirm({
      title: '删除 Passkey',
      message: '确定删除该 Passkey？',
      confirmLabel: '删除',
      danger: true,
    });
    if (!ok) return;
    try {
      await api<{ ok: boolean }>(`/api/me/passkeys/${id}`, { method: 'DELETE' });
      showToast('已删除');
      load();
    } catch (e) {
      showToast(e instanceof Error ? e.message : '删除失败');
    }
  }

  function startOAuthBind(provider: OAuthProvider) {
    window.location.href = `/api/oauth/${provider}/start?mode=bind&next=${encodeURIComponent('/me/profile')}`;
  }

  async function unlinkOAuth() {
    if (!oauthModalProvider) return;
    const label = oauthModalProvider === 'google' ? 'Google' : 'Microsoft';
    const ok = await confirm({
      title: `解绑 ${label}`,
      message: `确定解绑 ${label} 账号？`,
      confirmLabel: '解绑',
      danger: true,
    });
    if (!ok) return;
    setOAuthBusy(true);
    try {
      await api(`/api/me/oauth/${oauthModalProvider}-link`, { method: 'DELETE' });
      showToast(`${label} 已解绑`);
      setOauthModalProvider(null);
      load();
    } catch (e) {
      showToast(e instanceof Error ? e.message : '解绑失败');
    } finally {
      setOAuthBusy(false);
    }
  }

  if (loading) {
    return (
      <div className="admin-main-body">
        <p className="sub">加载中…</p>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="admin-main-body">
        <p className="error">加载失败</p>
      </div>
    );
  }

  const passkeyOn = passkeys.length > 0;
  const googleLinked = Boolean(oauthInfo?.googleLinked);
  const microsoftLinked = Boolean(oauthInfo?.microsoftLinked);

  const modalLinked =
    oauthModalProvider === 'google' ? googleLinked : oauthModalProvider === 'microsoft' ? microsoftLinked : false;
  const modalEmail =
    oauthModalProvider === 'google' ? oauthInfo?.googleEmail : oauthInfo?.microsoftEmail;
  const modalCanUnlink =
    oauthModalProvider === 'google' ? oauthInfo?.googleCanUnlink : oauthInfo?.microsoftCanUnlink;
  const providerLabel = oauthModalProvider === 'google' ? 'Google' : 'Microsoft';

  return (
    <>
      <div className="main-head">
        <div className="head-text">
          <h1 className="head-title">用户信息</h1>
          <p className="head-sub">查看和管理你的账号信息。</p>
        </div>
      </div>

      <div className="admin-main-body">
        <article className="card span-12">
          <h3>基本信息</h3>
          <div className="config-field">
            <label>名字</label>
            <div className="inline-edit-row">
              <input value={nameInput} onChange={(e) => setNameInput(e.target.value)} />
              <button
                type="button"
                className="btn primary"
                disabled={saving || !nameInput.trim() || nameInput.trim() === user.name}
                onClick={saveName}
              >
                保存
              </button>
            </div>
          </div>
          <div className="config-field">
            <label>邮箱</label>
            <div className="inline-edit-row">
              <input type="email" value={emailInput} onChange={(e) => setEmailInput(e.target.value)} />
              <button
                type="button"
                className="btn primary"
                disabled={saving || !emailInput.trim() || emailInput.trim().toLowerCase() === user.email}
                onClick={saveEmail}
              >
                保存
              </button>
            </div>
          </div>
          <div className="config-field">
            <label>角色</label>
            <input value={user.role === 'admin' ? '管理员' : '普通用户'} readOnly />
          </div>
        </article>

        <article className="card span-12">
          <h3>身份验证方式</h3>
          <div className="row-actions">
            <button
              type="button"
              className="credential-btn icon"
              title="管理 Passkey"
              onClick={() => setPkModalOpen(true)}
            >
              <PasskeyIcon linked={passkeyOn} />
            </button>
            <button
              type="button"
              className="credential-btn icon"
              title={googleLinked ? `Google: ${oauthInfo?.googleEmail || '已绑定'}` : '管理 Google 关联'}
              onClick={() => setOauthModalProvider('google')}
            >
              <ProviderIcon provider="google" linked={googleLinked} />
            </button>
            <button
              type="button"
              className="credential-btn icon"
              title={microsoftLinked ? `Microsoft: ${oauthInfo?.microsoftEmail || '已绑定'}` : '管理 Microsoft 关联'}
              onClick={() => setOauthModalProvider('microsoft')}
            >
              <ProviderIcon provider="microsoft" linked={microsoftLinked} />
            </button>
          </div>
        </article>
      </div>

      {pkModalOpen && (
        <AnchoredModal onClose={() => setPkModalOpen(false)} className="users-modal users-pk-modal">
          <div className="users-modal-header">
            <div className="users-modal-title">我的 Passkey</div>
            <div className="users-modal-sub">
              {passkeys.length === 0 ? '暂无 Passkey' : `已绑定 ${passkeys.length} 个 Passkey`}
            </div>
          </div>
          <div className="users-modal-body">
            {passkeys.length > 0 ? (
              <ul className="users-pk-list">
                {passkeys.map((pk) => (
                  <li key={pk.id} className="users-pk-item">
                    <PasskeyIcon linked />
                    <span>{pk.deviceType || 'Passkey'}</span>
                    <span className="sub">{formatDate(pk.createdAt)}</span>
                    <button
                      type="button"
                      className="credential-btn danger"
                      onClick={() => deletePasskey(pk.id)}
                      disabled={passkeys.length <= 1 && !googleLinked && !microsoftLinked}
                    >
                      删除
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="sub">点击下方按钮直接在本设备注册 Passkey</p>
            )}
          </div>
          <div className="users-modal-footer">
            <button type="button" className="btn" disabled={pkBusy} onClick={addPasskey} style={{ marginRight: 'auto' }}>
              {pkBusy ? '处理中…' : '添加 Passkey'}
            </button>
            <button type="button" className="btn" onClick={() => setPkModalOpen(false)}>
              关闭
            </button>
          </div>
        </AnchoredModal>
      )}

      {oauthModalProvider && (
        <AnchoredModal onClose={() => setOauthModalProvider(null)} className="users-modal">
          <div className="users-modal-header">
            <div className="users-modal-title">{providerLabel} 关联管理</div>
            <div className="users-modal-sub">
              {modalLinked ? `已绑定：${modalEmail || '—'}` : '尚未绑定，点击卡片可发起绑定'}
            </div>
          </div>
          <div className="users-modal-body">
            <div
              className="users-google-card"
              role="button"
              tabIndex={0}
              onClick={() => !modalLinked && startOAuthBind(oauthModalProvider)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !modalLinked) startOAuthBind(oauthModalProvider);
              }}
            >
              <img
                className={`users-google-link-icon ${oauthModalProvider === 'google' ? 'icon-google' : 'icon-microsoft'} ${modalLinked ? 'on' : 'off'}`}
                src={oauthModalProvider === 'google' ? '/img/google.svg' : '/img/microsoft.svg'}
                alt={providerLabel}
              />
              <div className="users-google-info">
                <div className="users-google-title">
                  {modalLinked ? `已关联 ${providerLabel}` : `未关联 ${providerLabel}`}
                </div>
                <div className="users-google-sub">
                  {modalLinked ? modalEmail || '—' : '点击卡片即可直接添加关联'}
                </div>
              </div>
            </div>
          </div>
          <div className="users-modal-footer">
            {modalLinked && modalCanUnlink && (
              <button type="button" className="btn danger" disabled={oauthBusy} onClick={unlinkOAuth} style={{ marginRight: 'auto' }}>
                解绑
              </button>
            )}
            {modalLinked && !modalCanUnlink && (
              <span className="sub" style={{ marginRight: 'auto', fontSize: '11px' }}>
                唯一验证身份，不可解绑
              </span>
            )}
            <button type="button" className="btn" onClick={() => setOauthModalProvider(null)}>
              关闭
            </button>
          </div>
        </AnchoredModal>
      )}

      {toastEl}
    </>
  );
}
