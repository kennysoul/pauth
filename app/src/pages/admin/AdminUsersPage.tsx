import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import QRCode from 'qrcode';
import { api, type AdminUser, type Me, type PasskeyCredential, type PasskeyDelegateResult } from '../../api';
import { useToast } from '../../components/useToast';
import { useConfirm } from '../../components/ConfirmProvider';
import { AnchoredModal } from '../../components/AnchoredModal';

type OAuthProvider = 'google' | 'microsoft';

type OAuthModalState = {
  provider: OAuthProvider;
  user: AdminUser;
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

function statusLabel(u: AdminUser) {
  if (u.status === 'pending' && !u.hasPendingInvite) return '待审批';
  if (u.hasPendingInvite && u.status === 'pending') return '待注册';
  if (u.status === 'active') return '已激活';
  if (u.status === 'disabled') return '已禁用';
  return u.status;
}

function statusChipClass(u: AdminUser) {
  if (u.hasPendingInvite && u.status === 'pending') return 'pending';
  return u.status;
}

export function AdminUsersPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [me, setMe] = useState<Me | null>(null);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [usersLoading, setUsersLoading] = useState(true);
  const [registrationEnabled, setRegistrationEnabled] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { showToast, toastEl } = useToast();
  const confirm = useConfirm();
  const [saving, setSaving] = useState(false);

  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState('');
  const [createError, setCreateError] = useState('');

  const [renameUser, setRenameUser] = useState<AdminUser | null>(null);
  const [renameName, setRenameName] = useState('');

  const [l1TogglingId, setL1TogglingId] = useState<string | null>(null);

  const [oauthModal, setOauthModal] = useState<OAuthModalState | null>(null);
  const [allowEmail, setAllowEmail] = useState('');
  const [oauthBusy, setOAuthBusy] = useState(false);

  const [pkUser, setPkUser] = useState<AdminUser | null>(null);
  const [pkList, setPkList] = useState<PasskeyCredential[]>([]);
  const [pkLoading, setPkLoading] = useState(false);
  const [pkLink, setPkLink] = useState('');
  const [pkQr, setPkQr] = useState('');
  const [pkExpireSec, setPkExpireSec] = useState(0);
  const [pkAltDomain, setPkAltDomain] = useState('');
  const [pkAltLink, setPkAltLink] = useState('');
  const pkTimerRef = useRef<number | null>(null);

  const load = useCallback(async () => {
    setUsersLoading(true);
    try {
      setUsers(await api<AdminUser[]>('/api/admin/users'));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed');
    } finally {
      setUsersLoading(false);
    }
  }, []);

  useEffect(() => {
    api<Me>('/api/me').then(setMe).catch(() => setMe(null));
    api<{ registrationEnabled: boolean }>('/api/admin/config')
      .then((c) => setRegistrationEnabled(c.registrationEnabled))
      .catch(() => setRegistrationEnabled(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    const oauth = searchParams.get('oauth');
    const oauthError = searchParams.get('oauth_error');
    if (oauthError) {
      setError(decodeURIComponent(oauthError));
      setSearchParams({}, { replace: true });
      return;
    }
    if (oauth === 'google_bound' || oauth === 'microsoft_bound') {
      showToast(oauth === 'google_bound' ? 'Google 账号已关联' : 'Microsoft 账号已关联');
      load();
      setSearchParams({}, { replace: true });
    }
  }, [searchParams, setSearchParams, load]);

  useEffect(() => {
    return () => {
      if (pkTimerRef.current) window.clearInterval(pkTimerRef.current);
    };
  }, []);

  function clearPkTimer() {
    if (pkTimerRef.current) {
      window.clearInterval(pkTimerRef.current);
      pkTimerRef.current = null;
    }
  }

  async function toggleRegistration(enabled: boolean) {
    await api('/api/admin/config', {
      method: 'PATCH',
      body: JSON.stringify({ registrationEnabled: enabled }),
    });
    setRegistrationEnabled(enabled);
    showToast(enabled ? '已开放注册' : '已关闭注册');
  }

  async function createUser() {
    const name = createName.trim();
    if (!name) {
      setCreateError('用户名不能为空');
      return;
    }
    setSaving(true);
    setCreateError('');
    try {
      await api('/api/admin/users', {
        method: 'POST',
        body: JSON.stringify({ name, role: 'user' }),
      });
      setCreateOpen(false);
      setCreateName('');
      showToast('用户创建成功');
      load();
    } catch (e) {
      setCreateError(e instanceof Error ? e.message : '创建失败');
    } finally {
      setSaving(false);
    }
  }

  function openRenameModal(u: AdminUser) {
    setRenameUser(u);
    setRenameName(u.name);
  }

  async function saveRename() {
    if (!renameUser) return;
    const name = renameName.trim();
    if (!name) {
      setError('名字不能为空');
      return;
    }
    setSaving(true);
    try {
      await api(`/api/admin/users/${renameUser.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ name }),
      });
      setRenameUser(null);
      showToast('名字已更新');
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed');
    } finally {
      setSaving(false);
    }
  }

  async function approve(id: string) {
    await api(`/api/admin/users/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'active' }),
    });
    showToast('用户已批准');
    load();
  }

  async function enableUser(id: string) {
    await api(`/api/admin/users/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'active' }),
    });
    load();
  }

  async function disable(id: string) {
    const ok = await confirm({
      title: '停用用户',
      message: '确定禁用该用户？',
      confirmLabel: '停用',
      danger: true,
    });
    if (!ok) return;
    await api(`/api/admin/users/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'disabled' }),
    });
    load();
  }

  async function removeUser(u: AdminUser) {
    const message =
      u.status === 'pending'
        ? `确定删除用户「${u.name}」？`
        : `确定永久删除用户「${u.name}」？其 Passkey 与权限将一并清除。`;
    const ok = await confirm({
      title: '删除用户',
      message,
      confirmLabel: '删除',
      danger: true,
    });
    if (!ok) return;
    try {
      await api(`/api/admin/users/${u.id}`, { method: 'DELETE' });
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed');
    }
  }

  async function toggleL1(u: AdminUser) {
    if (u.role === 'admin' || l1TogglingId) return;
    const next = !u.l1Enabled;
    setL1TogglingId(u.id);
    setError(null);
    try {
      await api(`/api/admin/users/${u.id}/permissions`, {
        method: 'PUT',
        body: JSON.stringify({ l1Enabled: next }),
      });
      setUsers((prev) => prev.map((row) => (row.id === u.id ? { ...row, l1Enabled: next } : row)));
      showToast(next ? `已为用户「${u.name}」启用 L1` : `已为用户「${u.name}」停用 L1`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed');
    } finally {
      setL1TogglingId(null);
    }
  }

  function renderRoleCell(u: AdminUser) {
    return (
      <div className="role-cell">
        <span className={`role-chip ${u.role === 'admin' ? 'admin' : 'user'}`}>
          {u.role === 'admin' ? '管理员' : '普通用户'}
        </span>
        {u.role !== 'admin' && (
          <button
            type="button"
            className={`l1-chip${u.l1Enabled ? ' on' : ' off'}`}
            title={u.l1Enabled ? 'L1 已启用，点击停用' : 'L1 未启用，点击启用'}
            disabled={l1TogglingId === u.id}
            onClick={() => toggleL1(u)}
          >
            L1
          </button>
        )}
      </div>
    );
  }

  function openOAuthModal(user: AdminUser, provider: OAuthProvider) {
    setOauthModal({ user, provider });
    setAllowEmail(provider === 'google' ? user.googleAllowedEmail : user.microsoftAllowedEmail);
    setError(null);
  }

  async function saveAllowedEmail() {
    if (!oauthModal) return;
    setOAuthBusy(true);
    try {
      const path =
        oauthModal.provider === 'google'
          ? `/api/admin/users/${oauthModal.user.id}/google-allow-email`
          : `/api/admin/users/${oauthModal.user.id}/microsoft-allow-email`;
      await api(path, {
        method: 'POST',
        body: JSON.stringify({ email: allowEmail.trim() }),
      });
      showToast('首次绑定限定邮箱已保存');
      setOauthModal(null);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed');
    } finally {
      setOAuthBusy(false);
    }
  }

  async function unlinkOAuth() {
    if (!oauthModal) return;
    const label = oauthModal.provider === 'google' ? 'Google' : 'Microsoft';
    const ok = await confirm({
      title: `解绑 ${label}`,
      message: `确定解绑 ${label} 账号？`,
      confirmLabel: '解绑',
      danger: true,
    });
    if (!ok) return;
    setOAuthBusy(true);
    try {
      const path =
        oauthModal.provider === 'google'
          ? `/api/admin/users/${oauthModal.user.id}/google-link`
          : `/api/admin/users/${oauthModal.user.id}/microsoft-link`;
      await api(path, { method: 'DELETE' });
      showToast(`${label} 已解绑`);
      setOauthModal(null);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed');
    } finally {
      setOAuthBusy(false);
    }
  }

  function startOAuthBind(user: AdminUser, provider: OAuthProvider) {
    const enabled = provider === 'google' ? user.googleEnabled : user.microsoftEnabled;
    if (!enabled) {
      setError(`${provider === 'google' ? 'Google' : 'Microsoft'} OAuth 未配置，请先到「集成与安全」中填写`);
      return;
    }
    window.location.href = `/api/oauth/${provider}/start?mode=bind&bind_user_id=${encodeURIComponent(user.id)}&next=${encodeURIComponent('/admin/users')}`;
  }

  async function loadPkList(user: AdminUser) {
    setPkLoading(true);
    try {
      const res = await api<{ credentials: PasskeyCredential[] }>(`/api/admin/users/${user.id}/passkeys`);
      setPkList(res.credentials);
    } catch {
      setPkList([]);
    } finally {
      setPkLoading(false);
    }
  }

  function closePkModal() {
    clearPkTimer();
    setPkUser(null);
    setPkList([]);
    setPkLink('');
    setPkQr('');
    setPkExpireSec(0);
    setPkAltDomain('');
    setPkAltLink('');
  }

  async function openPkModal(user: AdminUser) {
    setPkUser(user);
    setPkLink('');
    setPkQr('');
    setPkExpireSec(0);
    setPkAltDomain('');
    setPkAltLink('');
    await loadPkList(user);
  }

  function startPkCountdown(seconds: number) {
    clearPkTimer();
    let remaining = seconds;
    const tick = () => {
      if (remaining <= 0) {
        clearPkTimer();
        setPkExpireSec(0);
        return;
      }
      setPkExpireSec(remaining);
      remaining -= 1;
    };
    tick();
    pkTimerRef.current = window.setInterval(tick, 1000);
  }

  async function generatePkLink() {
    if (!pkUser) return;
    setPkLoading(true);
    try {
      const res = await api<PasskeyDelegateResult>(`/api/admin/users/${pkUser.id}/passkeys/delegate`, {
        method: 'POST',
      });
      setPkLink(res.link);
      setPkQr(await QRCode.toDataURL(res.link, { margin: 1, width: 180 }));
      startPkCountdown(res.expiresIn);
      setPkAltDomain('');
      setPkAltLink('');
    } catch (e) {
      setError(e instanceof Error ? e.message : '生成失败');
    } finally {
      setPkLoading(false);
    }
  }

  function updateAltLink(domain: string, baseLink: string) {
    const trimmed = domain.trim().replace(/\/+$/, '');
    if (!trimmed || !baseLink) {
      setPkAltLink('');
      return;
    }
    try {
      const url = new URL(baseLink);
      const alt = new URL(url.pathname + url.search, trimmed.endsWith('/') ? trimmed : `${trimmed}/`);
      setPkAltLink(alt.toString());
    } catch {
      setPkAltLink('');
    }
  }

  async function copyText(text: string) {
    if (!text) return;
    await navigator.clipboard.writeText(text);
    showToast('已复制到剪贴板');
  }

  async function deletePk(userId: string, pkId: string) {
    const ok = await confirm({
      title: '删除 Passkey',
      message: '确定删除该 Passkey？',
      confirmLabel: '删除',
      danger: true,
    });
    if (!ok) return;
    await api(`/api/admin/users/${userId}/passkeys/${pkId}`, { method: 'DELETE' });
    if (pkUser) await loadPkList(pkUser);
    load();
  }

  const canManageUser = (u: AdminUser) =>
    me && u.id !== me.id && u.role !== 'admin' && !u.isRoot;

  const modalLinked =
    oauthModal &&
    (oauthModal.provider === 'google' ? oauthModal.user.googleLinked : oauthModal.user.microsoftLinked);
  const modalEmail =
    oauthModal &&
    (oauthModal.provider === 'google' ? oauthModal.user.googleEmail : oauthModal.user.microsoftEmail);
  const modalCanUnlink =
    oauthModal &&
    (oauthModal.provider === 'google'
      ? oauthModal.user.googleCanUnlink
      : oauthModal.user.microsoftCanUnlink);
  const modalEnabled =
    oauthModal &&
    (oauthModal.provider === 'google' ? oauthModal.user.googleEnabled : oauthModal.user.microsoftEnabled);
  const providerLabel = oauthModal?.provider === 'google' ? 'Google' : 'Microsoft';

  function renderActions(u: AdminUser) {
    const passkeyOn = u.hasPasskey || u.passkeyCount > 0;
    const googleLinked = u.googleLinked;
    const microsoftLinked = u.microsoftLinked;

    return (
      <div className="row-actions">
        {u.status === 'pending' && !u.hasPendingInvite && (
          <button type="button" className="credential-btn" onClick={() => approve(u.id)}>
            批准
          </button>
        )}
        {!u.isRoot && (
          <button type="button" className="credential-btn" onClick={() => openRenameModal(u)}>
            改名
          </button>
        )}
        <button
          type="button"
          className="credential-btn icon"
          title="管理 Passkey"
          onClick={() => openPkModal(u)}
        >
          <PasskeyIcon linked={passkeyOn} />
        </button>
        <button
          type="button"
          className="credential-btn icon"
          title={googleLinked ? `Google: ${u.googleEmail || '已绑定'}` : '管理 Google 关联'}
          onClick={() => openOAuthModal(u, 'google')}
        >
          <ProviderIcon provider="google" linked={googleLinked} />
        </button>
        <button
          type="button"
          className="credential-btn icon"
          title={microsoftLinked ? `Microsoft: ${u.microsoftEmail || '已绑定'}` : '管理 Microsoft 关联'}
          onClick={() => openOAuthModal(u, 'microsoft')}
        >
          <ProviderIcon provider="microsoft" linked={microsoftLinked} />
        </button>
        {canManageUser(u) && u.status === 'disabled' && (
          <button type="button" className="credential-btn primary" onClick={() => enableUser(u.id)}>
            启用
          </button>
        )}
        {canManageUser(u) && u.status === 'active' && (
          <button type="button" className="credential-btn warn" onClick={() => disable(u.id)}>
            停用
          </button>
        )}
        {canManageUser(u) && (
          <button type="button" className="credential-btn danger" onClick={() => removeUser(u)}>
            删除
          </button>
        )}
      </div>
    );
  }

  return (
    <>
      <div className="main-head">
        <div className="head-text">
          <h1 className="head-title">用户设置</h1>
          <p className="head-sub">管理开放注册与用户账号。</p>
        </div>
        <div className="page-header-actions">
          <button type="button" className="btn" disabled={usersLoading} onClick={() => load()}>
            {usersLoading ? '加载中…' : '重新加载'}
          </button>
        </div>
      </div>

      <div className="admin-main-body">
        {error && <p className="error">{error}</p>}

        <article className="card span-12 users-settings-card">
            <h3>开放注册</h3>
            <div className="users-toggle-row">
              <div>
                <div className="status-title">开放注册</div>
                <div className="status-sub">开启后新用户可自行注册账号（注册后需管理员审核）</div>
              </div>
              <label className="toggle-pill">
                <input
                  type="checkbox"
                  checked={registrationEnabled}
                  onChange={(e) => toggleRegistration(e.target.checked)}
                />
                <span className="toggle-pill-ui" />
              </label>
            </div>
          </article>

        <article className="card span-12">
          <div className="settings-inline-head">
            <h3>用户列表</h3>
            <div className="inline-actions">
              <button type="button" className="qq-add-btn" onClick={() => setCreateOpen(true)}>
                ＋ 添加用户
              </button>
            </div>
          </div>

          <div className="settings-table-wrap">
            <table className="settings-table">
              <thead>
                <tr>
                  <th>用户名</th>
                  <th>角色</th>
                  <th>状态</th>
                  <th>注册时间</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {usersLoading ? (
                  <tr>
                    <td colSpan={5} className="table-empty">
                      加载中…
                    </td>
                  </tr>
                ) : users.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="table-empty">
                      暂无用户
                    </td>
                  </tr>
                ) : (
                  users.map((u) => (
                    <tr key={u.id}>
                      <td>
                        {u.name}
                        {u.isRoot && <span className="role-chip admin" style={{ marginLeft: '0.5rem' }}>root</span>}
                      </td>
                      <td>{renderRoleCell(u)}</td>
                      <td>
                        <span className={`status-chip ${statusChipClass(u)}`}>{statusLabel(u)}</span>
                      </td>
                      <td>{formatDate(u.createdAt)}</td>
                      <td>{renderActions(u)}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </article>
      </div>

      {createOpen && (
        <AnchoredModal onClose={() => setCreateOpen(false)} className="users-modal users-create-modal">
            <div className="users-modal-header">
              <div className="users-modal-title">新增用户</div>
              <div className="users-modal-sub">创建新用户并生成 Passkey 注册链接</div>
            </div>
            <div className="users-modal-body">
              <div className="users-create-form">
                <input
                  id="create-name"
                  className="users-create-input"
                  value={createName}
                  onChange={(e) => setCreateName(e.target.value)}
                  placeholder="用户名"
                  autoFocus
                />
                <div className="users-create-hint">用户名至少 1 个字符，不限制长度。</div>
                {createError && <div className="users-pk-msg" style={{ color: '#f87171' }}>{createError}</div>}
              </div>
            </div>
            <div className="users-modal-footer">
              <button type="button" className="btn" onClick={() => setCreateOpen(false)}>
                取消
              </button>
              <button type="button" className="btn primary" disabled={saving || !createName.trim()} onClick={createUser}>
                {saving ? '创建中…' : '创建'}
              </button>
            </div>
        </AnchoredModal>
      )}

      {renameUser && (
        <AnchoredModal onClose={() => setRenameUser(null)} className="users-modal" style={{ width: 360 }}>
            <div className="users-modal-header">
              <div className="users-modal-title">修改用户名</div>
              <div className="users-modal-sub">修改 {renameUser.name} 的显示名称</div>
            </div>
            <div className="users-modal-body">
              <input
                value={renameName}
                onChange={(e) => setRenameName(e.target.value)}
                placeholder="新用户名"
                autoFocus
              />
            </div>
            <div className="users-modal-footer">
              <button type="button" className="btn" onClick={() => setRenameUser(null)}>
                取消
              </button>
              <button type="button" className="btn primary" disabled={saving || !renameName.trim()} onClick={saveRename}>
                {saving ? '保存中…' : '保存'}
              </button>
            </div>
        </AnchoredModal>
      )}

      {oauthModal && (
        <AnchoredModal onClose={() => setOauthModal(null)} className="users-modal">
            <div className="users-modal-header">
              <div className="users-modal-title">
                {providerLabel} 关联管理 · {oauthModal.user.name}
              </div>
              <div className="users-modal-sub">
                {modalLinked ? `已绑定：${modalEmail || '—'}` : '尚未绑定，点击卡片可发起绑定'}
              </div>
            </div>
            <div className="users-modal-body">
              <div
                className="users-google-card"
                role="button"
                tabIndex={0}
                onClick={() => modalEnabled && startOAuthBind(oauthModal.user, oauthModal.provider)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && modalEnabled) startOAuthBind(oauthModal.user, oauthModal.provider);
                }}
              >
                <img
                  className={`users-google-link-icon ${oauthModal.provider === 'google' ? 'icon-google' : 'icon-microsoft'} ${modalLinked ? 'on' : 'off'}`}
                  src={oauthModal.provider === 'google' ? '/img/google.svg' : '/img/microsoft.svg'}
                  alt={providerLabel}
                />
                <div className="users-google-info">
                  <div className="users-google-title">
                    {modalLinked ? `已关联 ${providerLabel}` : `未关联 ${providerLabel}`}
                  </div>
                  <div className="users-google-sub">
                    {modalLinked
                      ? modalEmail || '—'
                      : modalEnabled
                        ? '点击卡片即可直接添加关联'
                        : '请先在「集成与安全」中配置 OAuth'}
                  </div>
                </div>
              </div>

              <div className="users-google-limit-box">
                <div className="users-google-limit-title">首次绑定限定邮箱</div>
                <p className="sub" style={{ margin: '4px 0 0', fontSize: '11px' }}>
                  仅在该用户首次 {providerLabel} 绑定时生效。留空表示不限制。
                </p>
                <div className="users-google-limit-row">
                  <input
                    type="email"
                    value={allowEmail}
                    onChange={(e) => setAllowEmail(e.target.value)}
                    placeholder="例如: user@gmail.com"
                  />
                  <button type="button" className="credential-btn" disabled={oauthBusy} onClick={saveAllowedEmail}>
                    保存
                  </button>
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
                  无 Passkey 时不可解绑
                </span>
              )}
              <button type="button" className="btn" onClick={() => setOauthModal(null)}>
                关闭
              </button>
            </div>
        </AnchoredModal>
      )}

      {pkUser && (
        <AnchoredModal onClose={closePkModal} className="users-modal users-pk-modal">
            <div className="users-modal-header">
              <div className="users-modal-title">{pkUser.name} 的 Passkey</div>
              <div className="users-modal-sub">
                {pkList.length === 0 ? '该用户暂无 Passkey' : `已绑定 ${pkList.length} 个 Passkey`}
              </div>
            </div>
            <div className="users-modal-body">
              {pkLoading && pkList.length === 0 ? (
                <p className="sub">加载中…</p>
              ) : pkList.length > 0 ? (
                <ul className="users-pk-list">
                  {pkList.map((pk) => (
                    <li key={pk.id} className="users-pk-item">
                      <PasskeyIcon linked />
                      <span>{pk.name}</span>
                      <span className="sub">{formatDate(pk.createdAt)}</span>
                      <button type="button" className="credential-btn danger" onClick={() => deletePk(pkUser.id, pk.id)}>
                        删除
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}

              {(pkQr || pkList.length === 0) && (
                <div className={`users-qr-area${pkQr ? ' open' : ''}`}>
                  {pkQr ? (
                    <>
                      <div className="users-qr-label">用手机扫码添加 Passkey（有效期 10 分钟）</div>
                      <img src={pkQr} alt="QR Code" width={180} height={180} />
                      {pkExpireSec > 0 ? (
                        <div className="users-qr-expire">
                          链接有效期：{Math.floor(pkExpireSec / 60)}:
                          {String(pkExpireSec % 60).padStart(2, '0')}
                        </div>
                      ) : (
                        <div className="users-qr-expire expired">链接已过期，请重新生成</div>
                      )}
                      <div className="users-qr-label" style={{ marginTop: 8 }}>
                        点击复制链接，在其他设备浏览器中打开
                      </div>
                      <span className="users-qr-link" role="button" tabIndex={0} onClick={() => copyText(pkLink)}>
                        {pkLink}
                      </span>
                      <div style={{ marginTop: 10, borderTop: '1px solid #364b72', paddingTop: 10 }}>
                        <div className="users-qr-label" style={{ marginBottom: 6 }}>
                          换域名 — 输入后自动生成对应链接
                        </div>
                        <input
                          className="users-create-input"
                          style={{ fontSize: 11, padding: '5px 8px', marginBottom: 0 }}
                          value={pkAltDomain}
                          placeholder="https://yourdomain.com"
                          onChange={(e) => {
                            setPkAltDomain(e.target.value);
                            updateAltLink(e.target.value, pkLink);
                          }}
                        />
                        {pkAltLink && (
                          <span className="users-qr-link" role="button" tabIndex={0} onClick={() => copyText(pkAltLink)}>
                            {pkAltLink}
                          </span>
                        )}
                      </div>
                    </>
                  ) : (
                    <p className="sub">点击下方按钮生成 Passkey 注册链接</p>
                  )}
                </div>
              )}
            </div>
            <div className="users-modal-footer">
              <button type="button" className="btn" disabled={pkLoading} onClick={generatePkLink} style={{ marginRight: 'auto' }}>
                {pkQr ? '重新生成' : '添加 Passkey'}
              </button>
              <button type="button" className="btn" onClick={closePkModal}>
                关闭
              </button>
            </div>
        </AnchoredModal>
      )}
      {toastEl}
    </>
  );
}
