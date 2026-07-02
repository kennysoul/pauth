const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeOAuthEmail(email: string): string {
  const value = String(email || '').trim().toLowerCase();
  if (!value) return '';
  if (!value.includes('@')) return value;
  const [localRaw, domain] = value.split('@');
  let local = localRaw;
  if (domain === 'gmail.com') {
    local = local.split('+', 1)[0].replace(/\./g, '');
  }
  return `${local}@${domain}`;
}

export function isValidEmailFormat(email: string): boolean {
  return EMAIL_RE.test(email);
}
