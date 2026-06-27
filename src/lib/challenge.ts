import type { StoredChallenge } from '../types';

const TTL = 60;

export async function putChallenge(
  kv: KVNamespace,
  id: string,
  data: StoredChallenge,
) {
  await kv.put(`challenge:${id}`, JSON.stringify(data), { expirationTtl: TTL });
}

export async function getChallenge(
  kv: KVNamespace,
  id: string,
): Promise<StoredChallenge | null> {
  const raw = await kv.get(`challenge:${id}`);
  if (!raw) return null;
  return JSON.parse(raw) as StoredChallenge;
}

export async function deleteChallenge(kv: KVNamespace, id: string) {
  await kv.delete(`challenge:${id}`);
}

export function newChallengeId() {
  return crypto.randomUUID();
}
