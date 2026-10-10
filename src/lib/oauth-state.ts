import type { Env } from '../types';
import { sanitizeReturnTo } from './return-to';

export type OAuthStatePayload = {
  provider: 'google' | 'microsoft';
  mode: 'login' | 'bind' | 'register';
  next: string;
  bindUserId?: string;
  bindOperatorUserId?: string;
  registerCompleteToken?: string;
};

const TTL = 600;

export async function issueOAuthState(env: Env, payload: OAuthStatePayload): Promise<string> {
  const state = crypto.randomUUID().replace(/-/g, '');
  await env.CHALLENGES.put(`oauth_state:${state}`, JSON.stringify(payload), { expirationTtl: TTL });
  return state;
}

export async function takeOAuthState(env: Env, state: string | null | undefined): Promise<OAuthStatePayload | null> {
  const key = String(state || '').trim();
  if (!key) return null;
  const raw = await env.CHALLENGES.get(`oauth_state:${key}`);
  if (!raw) return null;
  await env.CHALLENGES.delete(`oauth_state:${key}`);
  return JSON.parse(raw) as OAuthStatePayload;
}

export function safeNextPath(next: string | null | undefined, fallback: string): string {
  const value = String(next || '').trim();
  if (!value.startsWith('/') || value.startsWith('//')) return fallback;
  return value;
}

/**
 * Post-login redirect target for OAuth.
 * Accepts same-origin relative paths, or absolute URLs allowed by sanitizeReturnTo
 * (L1 forward_auth return_to = https://app.example.com/...).
 */
export function resolveLoginNext(
  next: string | null | undefined,
  env: Env,
  fallback: string,
): string {
  const value = String(next || '').trim();
  if (!value) return fallback;
  const absolute = sanitizeReturnTo(value, env);
  if (absolute) return absolute;
  return safeNextPath(value, fallback);
}
