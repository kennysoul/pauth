import { Hono } from 'hono';
import type { AuthContext, Env } from '../types';
import { writeAuditLog } from '../lib/audit';
import {
  buildBackupPayload,
  importBackupPayload,
  parseBackupPayload,
  previewBackupPayload,
} from '../lib/backup';
import { decryptBackupPayload, encryptBackupPayload } from '../lib/backup-crypto';

export function registerAdminBackupRoutes(adminRoutes: Hono<{ Bindings: Env; Variables: AuthContext }>) {
  adminRoutes.post('/backup/export', async (c) => {
    try {
      const body = await c.req.json<{ password?: string }>();
      const password = String(body.password ?? '');
      const payload = await buildBackupPayload(c.env);
      const plaintext = JSON.stringify(payload);
      const bundle = await encryptBackupPayload(plaintext, password);
      const preview = previewBackupPayload(payload);

      await writeAuditLog(c.env, c.get('user').id, 'BACKUP_EXPORT', null, {
        users: preview.users,
        clients: preview.clients,
      });

      return c.json({
        ok: true,
        filename: `pauth-backup-${payload.exportedAt.slice(0, 10)}.json`,
        bundle,
        preview,
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : '导出失败';
      return c.json({ error: message }, 400);
    }
  });

  adminRoutes.post('/backup/preview', async (c) => {
    try {
      const body = await c.req.json<{ password?: string; bundle?: string }>();
      const password = String(body.password ?? '');
      const bundle = String(body.bundle ?? '').trim();
      if (!bundle) {
        return c.json({ error: '请提供备份文件内容' }, 400);
      }
      const plaintext = await decryptBackupPayload(bundle, password);
      const payload = parseBackupPayload(plaintext);
      return c.json({ ok: true, preview: previewBackupPayload(payload) });
    } catch (e) {
      const message = e instanceof Error ? e.message : '预览失败';
      return c.json({ error: message }, 400);
    }
  });

  adminRoutes.post('/backup/import', async (c) => {
    try {
      const body = await c.req.json<{ password?: string; bundle?: string }>();
      const password = String(body.password ?? '');
      const bundle = String(body.bundle ?? '').trim();
      if (!bundle) {
        return c.json({ error: '请提供备份文件内容' }, 400);
      }
      const plaintext = await decryptBackupPayload(bundle, password);
      const payload = parseBackupPayload(plaintext);
      const preview = await importBackupPayload(c.env, payload);

      await writeAuditLog(c.env, c.get('user').id, 'BACKUP_IMPORT', null, preview);

      return c.json({ ok: true, preview });
    } catch (e) {
      const message = e instanceof Error ? e.message : '导入失败';
      return c.json({ error: message }, 400);
    }
  });
}
