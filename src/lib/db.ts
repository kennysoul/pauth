import { drizzle } from 'drizzle-orm/d1';
import type { Env } from '../types';

export function getDb(env: Env) {
  return drizzle(env.DB);
}

export function nowIso() {
  return new Date().toISOString();
}

export function newId() {
  return crypto.randomUUID();
}
