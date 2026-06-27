import { eq, and, gt } from 'drizzle-orm';
import type { Context } from 'hono';
import type { Env, SessionRow, User } from '../types';
import { getDb, newId, nowIso } from './db';
import { sessions, users } from './schema';

type CookieKind = 'sid' | 'setup_sid' | 'reg_sid';

const COOKIE_NAMES: Record<SessionRow['kind'], CookieKind> = {
  normal: 'sid',
  setup: 'setup_sid',
  register: 'reg_sid',
};

const COOKIE_PATHS: Record<SessionRow['kind'], string> = {
  normal: '/',
  setup: '/api/setup',
  register: '/api/register',
};

async function hmacSign(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  return btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

async function hmacVerify(secret: string, data: string, sig: string): Promise<boolean> {
  const expected = await hmacSign(secret, data);
  return expected === sig;
}

export function buildCookie(
  env: Env,
  name: string,
  sessionId: string,
  signature: string,
  maxAge: number,
  path: string,
): string {
  const parts = [
    `${name}=${sessionId}.${signature}`,
    'HttpOnly',
    'SameSite=Lax',
    `Path=${path}`,
    `Max-Age=${maxAge}`,
  ];
  if (env.COOKIE_DOMAIN) {
    parts.push(`Domain=${env.COOKIE_DOMAIN}`);
  }
  if (env.ORIGIN.startsWith('https://')) {
    parts.push('Secure');
  }
  return parts.join('; ');
}

export function clearCookie(env: Env, name: string, path: string): string {
  const parts = [`${name}=`, 'HttpOnly', 'SameSite=Lax', `Path=${path}`, 'Max-Age=0'];
  if (env.COOKIE_DOMAIN) {
    parts.push(`Domain=${env.COOKIE_DOMAIN}`);
  }
  return parts.join('; ');
}

export async function createSession(
  env: Env,
  userId: string,
  kind: SessionRow['kind'],
): Promise<{ session: SessionRow; setCookie: string }> {
  const db = getDb(env);
  const ttl =
    kind === 'normal'
      ? parseInt(env.SESSION_TTL_SECONDS, 10)
      : parseInt(env.SETUP_TTL_SECONDS, 10);
  const id = newId();
  const expiresAt = new Date(Date.now() + ttl * 1000).toISOString();
  const createdAt = nowIso();

  await db.insert(sessions).values({
    id,
    userId,
    kind,
    expiresAt,
    createdAt,
  });

  const signature = await hmacSign(env.SESSION_SECRET, id);
  const cookieName = COOKIE_NAMES[kind];
  const setCookie = buildCookie(env, cookieName, id, signature, ttl, COOKIE_PATHS[kind]);

  return {
    session: { id, userId, kind, expiresAt, createdAt },
    setCookie,
  };
}

export async function deleteSession(env: Env, sessionId: string) {
  const db = getDb(env);
  await db.delete(sessions).where(eq(sessions.id, sessionId));
}

export async function deleteUserSessions(env: Env, userId: string) {
  const db = getDb(env);
  await db.delete(sessions).where(eq(sessions.userId, userId));
}

function rowToUser(row: typeof users.$inferSelect): User {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role as User['role'],
    status: row.status as User['status'],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function resolveFromCookie(
  c: Context<{ Bindings: Env }>,
  cookieName: CookieKind,
  kinds: SessionRow['kind'][],
): Promise<{ user: User; session: SessionRow } | null> {
  const full = getCookie(c, cookieName);
  if (!full) return null;

  const dot = full.lastIndexOf('.');
  if (dot <= 0) return null;
  const sessionId = full.slice(0, dot);
  const signature = full.slice(dot + 1);

  if (!(await hmacVerify(c.env.SESSION_SECRET, sessionId, signature))) {
    return null;
  }

  const db = getDb(c.env);
  const now = nowIso();
  const sessionRow = await db
    .select()
    .from(sessions)
    .where(and(eq(sessions.id, sessionId), gt(sessions.expiresAt, now)))
    .get();

  if (!sessionRow || !kinds.includes(sessionRow.kind as SessionRow['kind'])) {
    return null;
  }

  const userRow = await db.select().from(users).where(eq(users.id, sessionRow.userId)).get();
  if (!userRow) return null;

  return {
    user: rowToUser(userRow),
    session: {
      id: sessionRow.id,
      userId: sessionRow.userId,
      kind: sessionRow.kind as SessionRow['kind'],
      expiresAt: sessionRow.expiresAt,
      createdAt: sessionRow.createdAt,
    },
  };
}

function getCookie(c: Context, name: string): string | undefined {
  const cookie = c.req.raw.headers.get('Cookie') ?? '';
  const match = cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : undefined;
}

export async function resolveNormalSession(c: Context<{ Bindings: Env }>) {
  return resolveFromCookie(c, 'sid', ['normal']);
}

export async function resolveSetupSession(c: Context<{ Bindings: Env }>) {
  return resolveFromCookie(c, 'setup_sid', ['setup']);
}

export async function resolveRegisterSession(c: Context<{ Bindings: Env }>) {
  return resolveFromCookie(c, 'reg_sid', ['register']);
}

export async function resolveAnySessionForVerify(c: Context<{ Bindings: Env }>) {
  return resolveFromCookie(c, 'sid', ['normal']);
}

export function appendCookies(c: Context, ...cookies: string[]) {
  for (const ck of cookies) {
    c.header('Set-Cookie', ck, { append: true });
  }
}

export { rowToUser };
