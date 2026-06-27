export interface Env {
  DB: D1Database;
  CHALLENGES: KVNamespace;
  ASSETS: Fetcher;
  SESSION_SECRET: string;
  RP_ID: string;
  RP_NAME: string;
  ORIGIN: string;
  COOKIE_DOMAIN: string;
  AUTH_HOST: string;
  SESSION_TTL_SECONDS: string;
  SETUP_TTL_SECONDS: string;
}

export type User = {
  id: string;
  email: string;
  name: string;
  role: 'admin' | 'user';
  status: 'pending' | 'active' | 'disabled';
  createdAt: string;
  updatedAt: string;
};

export type SessionRow = {
  id: string;
  userId: string;
  kind: 'normal' | 'setup' | 'register';
  expiresAt: string;
  createdAt: string;
};

export type AuthContext = {
  user: User;
  session: SessionRow;
};

export type StoredChallenge = {
  id: string;
  type: 'registration' | 'authentication';
  userId: string;
  challenge: string;
  createdAt: number;
};
