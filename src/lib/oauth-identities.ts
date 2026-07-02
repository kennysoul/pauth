import { eq, and, ne } from 'drizzle-orm';
import type { Env } from '../types';
import { getDb, newId, nowIso } from './db';
import { oauthIdentities, users } from './schema';
import { normalizeOAuthEmail } from './oauth-email';

export type OAuthProvider = 'google' | 'microsoft';

export type OAuthIdentityRow = typeof oauthIdentities.$inferSelect;

export type OAuthProfile = {
  sub: string;
  email: string;
  emailVerified: boolean;
  displayName: string;
  avatarUrl: string;
};

export async function getOAuthIdentityForUser(
  env: Env,
  userId: string,
  provider: OAuthProvider,
): Promise<OAuthIdentityRow | null> {
  const db = getDb(env);
  return (
    (await db
      .select()
      .from(oauthIdentities)
      .where(and(eq(oauthIdentities.userId, userId), eq(oauthIdentities.provider, provider)))
      .get()) ?? null
  );
}

export async function getOAuthIdentityBySubject(
  env: Env,
  provider: OAuthProvider,
  providerSubject: string,
): Promise<OAuthIdentityRow | null> {
  const db = getDb(env);
  return (
    (await db
      .select()
      .from(oauthIdentities)
      .where(
        and(eq(oauthIdentities.provider, provider), eq(oauthIdentities.providerSubject, providerSubject)),
      )
      .get()) ?? null
  );
}

export async function bindOAuthIdentity(
  env: Env,
  userId: string,
  provider: OAuthProvider,
  profile: OAuthProfile,
): Promise<void> {
  const providerSubject = profile.sub.trim();
  if (!providerSubject) throw new Error('OAuth subject 无效');

  const db = getDb(env);
  const ts = nowIso();
  const payload = {
    providerSubject,
    email: profile.email,
    emailVerified: profile.emailVerified ? 1 : 0,
    displayName: profile.displayName,
    avatarUrl: profile.avatarUrl,
    updatedAt: ts,
  };

  const bySubject = await getOAuthIdentityBySubject(env, provider, providerSubject);
  if (bySubject && bySubject.userId !== userId) {
    throw new Error('该第三方账号已绑定其他用户');
  }

  const byUser = await getOAuthIdentityForUser(env, userId, provider);
  if (byUser) {
    await db.update(oauthIdentities).set(payload).where(eq(oauthIdentities.id, byUser.id));
    return;
  }

  if (bySubject) {
    await db.update(oauthIdentities).set({ ...payload, userId }).where(eq(oauthIdentities.id, bySubject.id));
    return;
  }

  await db.insert(oauthIdentities).values({
    id: newId(),
    userId,
    provider,
    ...payload,
    createdAt: ts,
  });
}

export async function deleteOAuthIdentityForUser(
  env: Env,
  userId: string,
  provider: OAuthProvider,
): Promise<void> {
  const db = getDb(env);
  await db
    .delete(oauthIdentities)
    .where(and(eq(oauthIdentities.userId, userId), eq(oauthIdentities.provider, provider)));
}

export async function getUserByAllowedEmail(
  env: Env,
  provider: OAuthProvider,
  email: string,
): Promise<(typeof users.$inferSelect) | null> {
  const normalized = normalizeOAuthEmail(email);
  if (!normalized) return null;
  const db = getDb(env);
  const column =
    provider === 'google' ? users.allowedGoogleEmail : users.allowedMicrosoftEmail;
  const row = await db.select().from(users).where(eq(column, normalized)).get();
  return row ?? null;
}

export async function setUserAllowedEmail(
  env: Env,
  userId: string,
  provider: OAuthProvider,
  email: string,
): Promise<void> {
  const normalized = normalizeOAuthEmail(email);
  const db = getDb(env);
  const column =
    provider === 'google' ? users.allowedGoogleEmail : users.allowedMicrosoftEmail;

  const ts = nowIso();
  if (normalized) {
    const conflict = await db
      .select({ id: users.id, name: users.name })
      .from(users)
      .where(and(ne(users.id, userId), eq(column, normalized)))
      .get();
    if (conflict) {
      throw new Error(`该邮箱已被用户 ${conflict.name} 使用`);
    }
  }

  await db
    .update(users)
    .set(
      provider === 'google'
        ? { allowedGoogleEmail: normalized, updatedAt: ts }
        : { allowedMicrosoftEmail: normalized, updatedAt: ts },
    )
    .where(eq(users.id, userId));
}

export async function clearUserAllowedEmail(
  env: Env,
  userId: string,
  provider: OAuthProvider,
): Promise<void> {
  await setUserAllowedEmail(env, userId, provider, '');
}
