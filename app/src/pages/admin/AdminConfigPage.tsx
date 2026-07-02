import { useRef, useState } from 'react';
import { api, type BackupExportResult, type BackupPreview } from '../../api';
import { useConfirm } from '../../components/ConfirmProvider';
import { useToast } from '../../components/useToast';

function downloadTextFile(filename: string, content: string) {
  const blob = new Blob([content], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function BackupPreviewStats({ preview }: { preview: BackupPreview }) {
  const items = [
    `${preview.users} 用户`,
    `${preview.passkeys} Passkey`,
    `${preview.clients} 应用`,
    `${preview.oauthIdentities} OAuth`,
    `${preview.l1Grants} L1`,
    `${preview.invites} 邀请`,
  ];
  return (
    <div className="config-preview">
      <div className="config-preview-stats">
        {items.map((item) => (
          <span key={item} className="config-preview-chip">
            {item}
          </span>
        ))}
      </div>
      <p className="config-preview-meta">
        导出时间 {preview.exportedAt.slice(0, 19).replace('T', ' ')}
        {' · '}
        {preview.registrationEnabled ? '开放注册' : '关闭注册'}
      </p>
    </div>
  );
}

export function AdminConfigPage() {
  const confirm = useConfirm();
  const { showToast, toastEl } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [error, setError] = useState<string | null>(null);
  const [resetOpen, setResetOpen] = useState(false);
  const [resetText, setResetText] = useState('');

  const [exportPassword, setExportPassword] = useState('');
  const [exportBusy, setExportBusy] = useState(false);

  const [importPassword, setImportPassword] = useState('');
  const [importBundle, setImportBundle] = useState('');
  const [importFilename, setImportFilename] = useState('');
  const [importPreview, setImportPreview] = useState<BackupPreview | null>(null);
  const [importBusy, setImportBusy] = useState(false);

  async function resetSystem() {
    await api('/api/admin/system/reset', {
      method: 'POST',
      body: JSON.stringify({ confirmation: resetText }),
    });
    window.location.href = '/setup';
  }

  async function exportBackup() {
    setError(null);
    setExportBusy(true);
    try {
      const result = await api<BackupExportResult>('/api/admin/backup/export', {
        method: 'POST',
        body: JSON.stringify({ password: exportPassword }),
      });
      downloadTextFile(result.filename, result.bundle);
      showToast(`已导出（不含 root）：${result.preview.users} 名用户`);
      setExportPassword('');
    } catch (e) {
      setError(e instanceof Error ? e.message : '导出失败');
    } finally {
      setExportBusy(false);
    }
  }

  async function onImportFileSelected(file: File | null) {
    setError(null);
    setImportPreview(null);
    setImportBundle('');
    setImportFilename('');
    if (!file) return;
    const text = await file.text();
    setImportBundle(text);
    setImportFilename(file.name);
  }

  async function previewImport() {
    setError(null);
    setImportBusy(true);
    try {
      const result = await api<{ preview: BackupPreview }>('/api/admin/backup/preview', {
        method: 'POST',
        body: JSON.stringify({ password: importPassword, bundle: importBundle }),
      });
      setImportPreview(result.preview);
    } catch (e) {
      setImportPreview(null);
      setError(e instanceof Error ? e.message : '预览失败');
    } finally {
      setImportBusy(false);
    }
  }

  async function confirmImport() {
    if (!importPreview) return;
    const ok = await confirm({
      title: '导入备份',
      message:
        '将替换除 root 外的所有用户、应用与系统配置。root 管理员的 Passkey 与登录状态不受影响。确定继续？',
      confirmLabel: '导入',
      danger: true,
    });
    if (!ok) return;

    setImportBusy(true);
    setError(null);
    try {
      await api('/api/admin/backup/import', {
        method: 'POST',
        body: JSON.stringify({ password: importPassword, bundle: importBundle }),
      });
      showToast('备份导入完成');
      setImportPassword('');
      setImportBundle('');
      setImportFilename('');
      setImportPreview(null);
      if (fileInputRef.current) fileInputRef.current.value = '';
    } catch (e) {
      setError(e instanceof Error ? e.message : '导入失败');
    } finally {
      setImportBusy(false);
    }
  }

  return (
    <>
      <div className="main-head">
        <div className="head-text">
          <h1 className="head-title">系统设置</h1>
          <p className="head-sub">加密备份与灾难恢复；开放注册请在用户管理中配置。</p>
        </div>
      </div>

      <div className="admin-main-body">
        {error && <p className="error span-12">{error}</p>}

        <article className="card span-12 config-backup-card">
          <div className="settings-inline-head">
            <div>
              <h3>加密备份</h3>
              <p className="config-card-desc">
                导出除 root 外的用户、Passkey、应用与配置；导入不覆盖 root 账号与 Passkey。
              </p>
            </div>
          </div>

          <div className="config-backup-grid">
            <section className="config-panel">
              <h4>导出</h4>
              <div className="config-field">
                <label htmlFor="export-password">备份密码</label>
                <input
                  id="export-password"
                  type="password"
                  value={exportPassword}
                  onChange={(e) => setExportPassword(e.target.value)}
                  placeholder="至少 8 位"
                  autoComplete="new-password"
                />
              </div>
              <button
                className="btn primary"
                disabled={exportBusy || exportPassword.length < 8}
                onClick={exportBackup}
              >
                {exportBusy ? '导出中…' : '下载备份'}
              </button>
            </section>

            <section className="config-panel">
              <h4>导入</h4>
              <div className="config-field">
                <label htmlFor="import-file">备份文件</label>
                <input
                  id="import-file"
                  ref={fileInputRef}
                  type="file"
                  accept="application/json,.json"
                  className="config-file-input"
                  onChange={(e) => onImportFileSelected(e.target.files?.[0] ?? null)}
                />
                {importFilename && <span className="config-file-name">{importFilename}</span>}
              </div>
              <div className="config-field">
                <label htmlFor="import-password">备份密码</label>
                <input
                  id="import-password"
                  type="password"
                  value={importPassword}
                  onChange={(e) => {
                    setImportPassword(e.target.value);
                    setImportPreview(null);
                  }}
                  autoComplete="current-password"
                />
              </div>
              <div className="config-actions">
                <button
                  type="button"
                  className="btn"
                  disabled={importBusy || !importBundle || !importPassword}
                  onClick={previewImport}
                >
                  {importBusy && !importPreview ? '解析中…' : '预览'}
                </button>
                <button
                  type="button"
                  className="btn primary"
                  disabled={importBusy || !importPreview}
                  onClick={confirmImport}
                >
                  {importBusy && importPreview ? '导入中…' : '确认导入'}
                </button>
              </div>
              {importPreview && <BackupPreviewStats preview={importPreview} />}
            </section>
          </div>
        </article>

        <article className="card span-12 config-danger-card">
          <div className="config-danger-head">
            <div>
              <h3>危险操作</h3>
              <p className="config-card-desc">重置将清空所有用户与 Passkey，系统回到初始化状态。</p>
            </div>
            {!resetOpen && (
              <button type="button" className="btn danger" onClick={() => setResetOpen(true)}>
                重置系统
              </button>
            )}
          </div>
          {resetOpen && (
            <div className="config-danger-form">
              <div className="config-field">
                <label htmlFor="confirm">输入 RESET_ALL_I_UNDERSTAND 确认</label>
                <input
                  id="confirm"
                  value={resetText}
                  onChange={(e) => setResetText(e.target.value)}
                  placeholder="RESET_ALL_I_UNDERSTAND"
                />
              </div>
              <div className="config-actions">
                <button
                  type="button"
                  className="btn danger"
                  disabled={resetText !== 'RESET_ALL_I_UNDERSTAND'}
                  onClick={resetSystem}
                >
                  确认重置
                </button>
                <button type="button" className="btn" onClick={() => setResetOpen(false)}>
                  取消
                </button>
              </div>
            </div>
          )}
        </article>
      </div>
      {toastEl}
    </>
  );
}
