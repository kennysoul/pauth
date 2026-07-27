import { useCallback, useEffect, useState } from 'react';
import { api } from '../../api';
import { useToast } from '../../components/useToast';

type Log = {
  id: string;
  action: string;
  actorId: string | null;
  targetId: string | null;
  detail: string | null;
  createdAt: string;
};

export function AdminLogsPage() {
  const { showToast, toastEl } = useToast();
  const [logs, setLogs] = useState<Log[]>([]);
  const [clearing, setClearing] = useState(false);

  const load = useCallback(() => {
    api<Log[]>('/api/admin/audit-logs').then(setLogs);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function clearLogs() {
    if (!window.confirm('确认清空所有审计日志？此操作不可恢复。')) return;
    setClearing(true);
    try {
      await api<{ ok: boolean }>('/api/admin/audit-logs', { method: 'DELETE' });
      showToast('审计日志已清空');
      load();
    } catch (e) {
      showToast(e instanceof Error ? e.message : '清空失败');
    } finally {
      setClearing(false);
    }
  }

  return (
    <>
      <div className="main-head">
        <div className="head-text">
          <h1 className="head-title">审计日志</h1>
          <p className="head-sub">系统操作记录。</p>
        </div>
        <div className="page-header-actions">
          <button
            type="button"
            className="btn danger"
            disabled={clearing || logs.length === 0}
            onClick={clearLogs}
          >
            {clearing ? '清空中…' : '清空日志'}
          </button>
        </div>
      </div>
      <div className="admin-main-body">
        <table>
          <thead>
            <tr>
              <th>时间</th>
              <th>操作</th>
              <th>操作人</th>
              <th>对象</th>
              <th>详情</th>
            </tr>
          </thead>
          <tbody>
            {logs.map((log) => (
              <tr key={log.id}>
                <td>{new Date(log.createdAt).toLocaleString()}</td>
                <td>{log.action}</td>
                <td>{log.actorId ?? '—'}</td>
                <td>{log.targetId ?? '—'}</td>
                <td>{log.detail ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {toastEl}
    </>
  );
}
