import type { Env } from '../types';
import { getDb, newId, nowIso } from './db';
import { auditLogs } from './schema';

export async function writeAuditLog(
  env: Env,
  actorId: string | null,
  action: string,
  targetId: string | null,
  detail: Record<string, unknown> | null,
) {
  const db = getDb(env);
  await db.insert(auditLogs).values({
    id: newId(),
    actorId,
    action,
    targetId,
    detail: detail ? JSON.stringify(detail) : null,
    createdAt: nowIso(),
  });
}
