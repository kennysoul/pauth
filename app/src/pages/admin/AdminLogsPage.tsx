import { useEffect, useState } from 'react';
import { api } from '../../api';

type Log = {
  id: string;
  action: string;
  actorId: string | null;
  targetId: string | null;
  detail: string | null;
  createdAt: string;
};

export function AdminLogsPage() {
  const [logs, setLogs] = useState<Log[]>([]);

  useEffect(() => {
    api<Log[]>('/api/admin/audit-logs').then(setLogs);
  }, []);

  return (
    <>
      <h1>审计日志</h1>
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
    </>
  );
}
