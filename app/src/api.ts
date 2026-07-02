export async function api<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const res = await fetch(path, {
    ...init,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });

  if (res.redirected) {
    window.location.href = res.url;
    throw new Error('Redirecting');
  }

  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) {
    throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`);
  }
  return data;
}

export type SystemState = {
  state: 'NEEDS_SETUP' | 'ACTIVE';
  registrationEnabled: boolean;
  origin?: string;
};

export type Me = {
  id: string;
  email: string;
  name: string;
  role: 'admin' | 'user';
  status: string;
};

export type AdminUser = {
  id: string;
  email: string;
  name: string;
  role: string;
  status: string;
  createdAt: string;
  passkeyCount: number;
  hasPendingInvite?: boolean;
  l1Enabled: boolean;
  googleEnabled: boolean;
  googleLinked: boolean;
  googleEmail: string;
  googleCanUnlink: boolean;
  googleAllowedEmail: string;
  microsoftEnabled: boolean;
  microsoftLinked: boolean;
  microsoftEmail: string;
  microsoftCanUnlink: boolean;
  microsoftAllowedEmail: string;
  hasPasskey: boolean;
};

export type PasskeyCredential = {
  id: string;
  name: string;
  deviceType: string | null;
  backedUp: boolean;
  createdAt: string;
  lastUsedAt: string | null;
};

export type PasskeyDelegateResult = {
  token: string;
  link: string;
  expiresIn: number;
};

export type WebAuthIntegration = {
  rpId: string;
  rpName: string;
  origin: string;
  cookieDomain: string;
  authHost: string;
  source: string;
};

export type GoogleIntegration = {
  clientId: string;
  redirectUri: string;
  scopes: string;
  clientSecretSet: boolean;
  enabled: boolean;
};

export type MicrosoftIntegration = {
  tenantId: string;
  clientId: string;
  redirectUri: string;
  scopes: string;
  clientSecretSet: boolean;
  enabled: boolean;
};

export type AdminClient = {
  id: string;
  clientId: string;
  name: string;
  accessMode: 'L2_ONLY' | 'L1_AND_L2';
  redirectUris: string[];
  clientSecret: string | null;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};

export type ClientCreateResult = {
  ok: boolean;
  id: string;
  clientId: string;
  clientSecret: string;
};

export type ClientSecretResult = {
  ok: boolean;
  clientId: string;
  clientSecret: string;
};

export type InviteResult = {
  ok: boolean;
  url: string;
  token: string;
  expiresAt: string;
  userId: string;
};

export type InviteInfo = {
  name: string;
  role: string;
};
