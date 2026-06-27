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
};
