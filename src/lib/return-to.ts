import type { Env } from '../types';

export function isAllowedReturnTo(url: string, env: Env): boolean {
  try {
    const u = new URL(url);
    const origin = new URL(env.ORIGIN);
    if (u.protocol !== origin.protocol) return false;

    const rpId = env.RP_ID;
    if (rpId === 'localhost') {
      return u.hostname === 'localhost' && u.port === origin.port;
    }

    return u.hostname === rpId || u.hostname.endsWith('.' + rpId);
  } catch {
    return false;
  }
}

export function isAllowedRedirectUri(url: string, env: Env): boolean {
  return isAllowedReturnTo(url, env);
}

/** OAuth callbacks: any HTTPS URL (or localhost HTTP for dev). Active users may authorize. */
export function isAllowedL2RedirectUri(url: string, _env: Env): boolean {
  try {
    const u = new URL(url);
    if (u.protocol === 'https:') return true;
    if (u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1')) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

export function sanitizeReturnTo(raw: string | null | undefined, env: Env): string | null {
  if (!raw) return null;
  return isAllowedReturnTo(raw, env) ? raw : null;
}
