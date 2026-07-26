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

/** OAuth callbacks: accept any valid URL (https, http, custom schemes — no restriction). */
export function isAllowedL2RedirectUri(url: string, _env: Env): boolean {
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
}

export function sanitizeReturnTo(raw: string | null | undefined, env: Env): string | null {
  if (!raw) return null;
  return isAllowedReturnTo(raw, env) ? raw : null;
}
