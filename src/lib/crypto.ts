export async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function newClientSecret(): string {
  return `sec_${crypto.randomUUID().replace(/-/g, '')}`;
}

export function newAuthCode(): string {
  return `ac_${crypto.randomUUID().replace(/-/g, '')}`;
}

export function newAccessToken(): string {
  return `at_${crypto.randomUUID().replace(/-/g, '')}`;
}

export function newIdToken(): string {
  return `id_${crypto.randomUUID().replace(/-/g, '')}`;
}

export function appendQuery(
  base: string,
  params: Record<string, string>,
  origin?: string,
): string {
  const url =
    base.startsWith('http://') || base.startsWith('https://')
      ? new URL(base)
      : new URL(base, origin);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}
