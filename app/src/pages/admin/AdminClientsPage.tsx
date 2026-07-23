import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { AnchoredModal } from '../../components/AnchoredModal';
import { api, type AdminClient, type ClientCreateResult, type ClientSecretResult, type ClientUsersResponse, type ClientUserEntry } from '../../api';

const emptyForm = {
  clientId: '',
  name: '',
  accessMode: 'L2_ONLY' as 'L2_ONLY' | 'L1_AND_L2',
  enabled: true,
};

type ConfirmAction =
  | { kind: 'delete'; client: AdminClient }
  | { kind: 'regenerate'; client: AdminClient }
  | { kind: 'generate'; client: AdminClient };

async function copyText(text: string) {
  await navigator.clipboard.writeText(text);
}

function clientConfigBlock(clientId: string, clientSecret: string, origin: string) {
  return `PAUTH_CLIENT_ID=${clientId}
PAUTH_CLIENT_SECRET=${clientSecret}
PAUTH_AUTHORIZE_URL=${origin}/api/l2/authorize
PAUTH_TOKEN_URL=${origin}/api/l2/token`;
}

function IconEye() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.75" />
    </svg>
  );
}

function IconEyeOff() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M3 3l18 18M10.58 10.58A3 3 0 0 0 12 15a3 3 0 0 0 2.42-4.42M9.9 4.24A10.94 10.94 0 0 1 12 4c7 0 10 7 10 7a16.2 16.2 0 0 1-3.17 4.19M6.12 6.12A16.2 16.2 0 0 0 2 12s3 7 10 7a10.94 10.94 0 0 0 4.24-.9"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function IconClose() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M6 6l12 12M18 6L6 18"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
      />
    </svg>
  );
}

function Modal({
  title,
  onClose,
  children,
  wide,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <AnchoredModal onClose={onClose} className={`modal card${wide ? ' modal-wide' : ''}`}>
      <div className="modal-header">
        <h2>{title}</h2>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="关闭">
          <IconClose />
        </button>
      </div>
      {children}
    </AnchoredModal>
  );
}

export function AdminClientsPage() {
  const [clients, setClients] = useState<AdminClient[]>([]);
  const [form, setForm] = useState(emptyForm);
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [visibleSecrets, setVisibleSecrets] = useState<Set<string>>(new Set());
  const [showHelp, setShowHelp] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [confirmAction, setConfirmAction] = useState<ConfirmAction | null>(null);
  const [saving, setSaving] = useState(false);
  const [authOrigin, setAuthOrigin] = useState('');
  const [userMgmtClient, setUserMgmtClient] = useState<AdminClient | null>(null);
  const [userMgmtData, setUserMgmtData] = useState<ClientUserEntry[]>([]);
  const [userMgmtSaving, setUserMgmtSaving] = useState(false);

  useEffect(() => {
    const fallback =
      typeof window !== 'undefined' && window.location.origin
        ? window.location.origin
        : 'https://auth.example.com';
    api<{ origin?: string }>('/api/system/state')
      .then((state) => setAuthOrigin(state.origin || fallback))
      .catch(() => setAuthOrigin(fallback));
  }, []);

  const originForDocs = authOrigin || 'https://auth.example.com';

  const load = useCallback(async () => {
    try {
      setClients(await api<AdminClient[]>('/api/admin/clients'));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed');
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  function toggleSecret(clientId: string) {
    setVisibleSecrets((prev) => {
      const next = new Set(prev);
      if (next.has(clientId)) next.delete(clientId);
      else next.add(clientId);
      return next;
    });
  }

  function openCreate() {
    setEditingId(null);
    setForm(emptyForm);
    setShowForm(true);
    setError(null);
  }

  function openEdit(c: AdminClient) {
    setEditingId(c.clientId);
    setForm({
      clientId: c.clientId,
      name: c.name,
      accessMode: c.accessMode,
      enabled: c.enabled,
    });
    setShowForm(true);
    setError(null);
  }

  function closeForm() {
    setShowForm(false);
    setEditingId(null);
    setForm(emptyForm);
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      if (editingId) {
        await api(`/api/admin/clients/${editingId}`, {
          method: 'PATCH',
          body: JSON.stringify({
            name: form.name,
            accessMode: form.accessMode,
            enabled: form.enabled,
          }),
        });
      } else {
        const result = await api<ClientCreateResult>('/api/admin/clients', {
          method: 'POST',
          body: JSON.stringify({
            clientId: form.clientId,
            name: form.name,
            accessMode: form.accessMode,
            enabled: form.enabled,
          }),
        });
        setVisibleSecrets((prev) => new Set(prev).add(result.clientId));
      }
      closeForm();
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed');
    } finally {
      setSaving(false);
    }
  }

  async function executeConfirm() {
    if (!confirmAction) return;
    setSaving(true);
    setError(null);
    try {
      const { clientId } = confirmAction.client;
      if (confirmAction.kind === 'delete') {
        await api(`/api/admin/clients/${clientId}`, { method: 'DELETE' });
        setVisibleSecrets((prev) => {
          const next = new Set(prev);
          next.delete(clientId);
          return next;
        });
      } else {
        await api<ClientSecretResult>(`/api/admin/clients/${clientId}/regenerate-secret`, {
          method: 'POST',
        });
        setVisibleSecrets((prev) => new Set(prev).add(clientId));
      }
      setConfirmAction(null);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed');
    } finally {
      setSaving(false);
    }
  }

  function confirmMessage(action: ConfirmAction) {
    const { clientId } = action.client;
    if (action.kind === 'delete') {
      return `确定删除应用「${clientId}」？此操作不可撤销。`;
    }
    if (action.kind === 'generate') {
      return `为「${clientId}」生成 Client Secret？`;
    }
    return `确定重新生成「${clientId}」的 Client Secret？旧 Secret 将立即失效。`;
  }

  function confirmTitle(action: ConfirmAction) {
    if (action.kind === 'delete') return '删除应用';
    if (action.kind === 'generate') return '生成 Secret';
    return '重置 Secret';
  }

  function confirmButtonLabel(action: ConfirmAction) {
    if (action.kind === 'delete') return '删除';
    if (action.kind === 'generate') return '生成';
    return '重置';
  }

  async function copyClientConfig(c: AdminClient) {
    if (!c.clientSecret) {
      setConfirmAction({ kind: 'generate', client: c });
      return;
    }
    await copyText(clientConfigBlock(c.clientId, c.clientSecret, originForDocs));
  }

  async function openUserMgmt(c: AdminClient) {
    setError(null);
    setUserMgmtClient(c);
    setUserMgmtData([]);
    try {
      const data = await api<ClientUsersResponse>(`/api/admin/clients/${c.clientId}/users`);
      setUserMgmtData(data.users);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed');
    }
  }

  function closeUserMgmt() {
    setUserMgmtClient(null);
    setUserMgmtData([]);
  }

  function toggleUser(userId: string) {
    setUserMgmtData((prev) =>
      prev.map((u) => (u.userId === userId ? { ...u, excluded: !u.excluded } : u)),
    );
  }

  async function saveUserMgmt() {
    if (!userMgmtClient) return;
    setUserMgmtSaving(true);
    setError(null);
    try {
      await api(`/api/admin/clients/${userMgmtClient.clientId}/users`, {
        method: 'PUT',
        body: JSON.stringify({
          entries: userMgmtData.map((u) => ({ userId: u.userId, excluded: u.excluded })),
        }),
      });
      closeUserMgmt();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed');
    } finally {
      setUserMgmtSaving(false);
    }
  }

  return (
    <>
      <div className="page-header">
        <h1>应用管理</h1>
        <div className="page-header-actions">
          <button type="button" className="secondary" onClick={() => setShowHelp(true)}>
            说明
          </button>
          <button type="button" onClick={openCreate}>
            新增
          </button>
        </div>
      </div>

      {error && !showForm && !confirmAction && <p className="error">{error}</p>}

      <h2 className="section-title">已注册应用</h2>
      <div className="table-wrap">
        <table className="clients-table">
          <colgroup>
            <col style={{ width: '13%' }} />
            <col style={{ width: '30%' }} />
            <col style={{ width: '11%' }} />
            <col style={{ width: '10%' }} />
            <col style={{ width: '8%' }} />
            <col style={{ width: '28%' }} />
          </colgroup>
          <thead>
            <tr>
              <th>Client ID</th>
              <th>Client Secret</th>
              <th>名称</th>
              <th>需 L1</th>
              <th>状态</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {clients.length === 0 ? (
              <tr>
                <td colSpan={6} className="empty-cell">
                  暂无应用，点击右上角「新增」创建
                </td>
              </tr>
            ) : (
              clients.map((c) => {
                const secretVisible = visibleSecrets.has(c.clientId);
                return (
                  <tr key={c.clientId}>
                    <td>
                      <code className="truncate" title={c.clientId}>
                        {c.clientId}
                      </code>
                    </td>
                    <td className="secret-cell">
                      {c.clientSecret ? (
                        <div className="cell-secret">
                          <code className="truncate" title={secretVisible ? c.clientSecret : undefined}>
                            {secretVisible ? c.clientSecret : '••••••••••••••••'}
                          </code>
                          <button
                            type="button"
                            className="icon-btn eye-btn"
                            onClick={() => toggleSecret(c.clientId)}
                            title={secretVisible ? '隐藏 Secret' : '显示 Secret'}
                            aria-label={secretVisible ? '隐藏 Secret' : '显示 Secret'}
                          >
                            {secretVisible ? <IconEyeOff /> : <IconEye />}
                          </button>
                        </div>
                      ) : (
                        <div className="cell-secret">
                          <span className="sub muted">未保存</span>
                          <button
                            type="button"
                            className="link-btn"
                            onClick={() => setConfirmAction({ kind: 'generate', client: c })}
                          >
                            生成
                          </button>
                        </div>
                      )}
                    </td>
                    <td>
                      <span className="truncate" title={c.name}>
                        {c.name}
                      </span>
                    </td>
                    <td>{c.accessMode === 'L1_AND_L2' ? '是' : '—'}</td>
                    <td>{c.enabled ? '启用' : '禁用'}</td>
                    <td className="actions">
                      <button className="secondary" onClick={() => openUserMgmt(c)}>
                        用户
                      </button>
                      <button className="secondary" onClick={() => copyClientConfig(c)}>
                        复制配置
                      </button>
                      <button className="secondary" onClick={() => openEdit(c)}>
                        编辑
                      </button>
                      <button
                        className="secondary"
                        onClick={() => setConfirmAction({ kind: 'regenerate', client: c })}
                      >
                        重置
                      </button>
                      <button
                        className="danger"
                        onClick={() => setConfirmAction({ kind: 'delete', client: c })}
                      >
                        删除
                      </button>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {showHelp && (
        <Modal title="接入说明" onClose={() => setShowHelp(false)} wide>
          <p className="sub modal-sub">
            在应用后端配置以下环境变量即可对接 OAuth 登录（类 Google OAuth）：
          </p>
          <pre className="config-snippet">{clientConfigBlock('<Client ID>', '<Client Secret>', originForDocs)}</pre>
          <p className="sub modal-sub">
            授权入口：
            <br />
            <code className="inline-code">
              GET /api/l2/authorize?client_id=...&amp;redirect_uri=...&amp;response_type=code&amp;state=...
            </code>
            <br />
            换 token：
            <br />
            <code className="inline-code">
              POST /api/l2/token（form: grant_type, code, client_id, client_secret, redirect_uri）
            </code>
          </p>
          <p className="sub modal-sub">
          回调地址无需配置，任意 HTTPS 域名均可。管理员可在「用户」按钮中限定哪些账号可用此应用登录。
          </p>
        </Modal>
      )}

      {showForm && (
        <Modal title={editingId ? '编辑应用' : '新增应用'} onClose={closeForm}>
          {error && <p className="error">{error}</p>}
          {!editingId && (
            <>
              <label htmlFor="clientId">Client ID</label>
              <input
                id="clientId"
                value={form.clientId}
                onChange={(e) => setForm({ ...form, clientId: e.target.value })}
                placeholder="sumusic"
              />
            </>
          )}
          <label htmlFor="cname">名称</label>
          <input
            id="cname"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={form.accessMode === 'L1_AND_L2'}
              onChange={(e) =>
                setForm({
                  ...form,
                  accessMode: e.target.checked ? 'L1_AND_L2' : 'L2_ONLY',
                })
              }
            />
            需要 L1 网关权限
          </label>
          <p className="sub">勾选后只有具备 L1 网关权限的用户才可登录。未勾选时可在「用户」按钮中排除特定用户。</p>
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={form.enabled}
              onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
            />
            启用
          </label>
          <div className="modal-actions">
            <button
              disabled={saving || (!editingId && !form.clientId.trim()) || !form.name.trim()}
              onClick={save}
            >
              {saving ? '保存中…' : editingId ? '保存' : '创建'}
            </button>
            <button type="button" className="secondary" onClick={closeForm}>
              取消
            </button>
          </div>
        </Modal>
      )}

      {confirmAction && (
        <Modal title={confirmTitle(confirmAction)} onClose={() => setConfirmAction(null)}>
          {error && <p className="error">{error}</p>}
          <p>{confirmMessage(confirmAction)}</p>
          <div className="modal-actions">
            <button
              className={confirmAction.kind === 'delete' ? 'danger' : undefined}
              disabled={saving}
              onClick={executeConfirm}
            >
              {saving ? '处理中…' : confirmButtonLabel(confirmAction)}
            </button>
            <button
              type="button"
              className="secondary"
              disabled={saving}
              onClick={() => setConfirmAction(null)}
            >
              取消
            </button>
          </div>
        </Modal>
      )}

      {userMgmtClient && (
        <Modal title={`应用用户 — ${userMgmtClient.name}`} onClose={closeUserMgmt} wide>
          {error && <p className="error">{error}</p>}
          <p className="sub modal-sub" style={{ marginBottom: 0 }}>
            勾选的用户将被<b>排除</b>，无法登录此应用。不勾选任何人时，所有激活用户均可登录。
          </p>
          {userMgmtData.length === 0 ? (
            <p className="empty-cell">暂无激活用户</p>
          ) : (
            <div className="user-mgmt-grid">
              {userMgmtData.map((u) => (
                <label
                  key={u.userId}
                  className={`user-mgmt-card${u.excluded ? ' excluded' : ''}`}
                >
                  <input
                    type="checkbox"
                    checked={u.excluded}
                    onChange={() => toggleUser(u.userId)}
                  />
                  <div className="user-mgmt-info">
                    <span className="user-mgmt-name">{u.name}</span>
                    <span className="user-mgmt-email">{u.email}</span>
                  </div>
                </label>
              ))}
            </div>
          )}
          <div className="modal-actions">
            <button disabled={userMgmtSaving} onClick={saveUserMgmt}>
              {userMgmtSaving ? '保存中…' : '保存'}
            </button>
            <button type="button" className="secondary" onClick={closeUserMgmt}>
              取消
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
