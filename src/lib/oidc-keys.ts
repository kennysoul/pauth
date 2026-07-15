import { eq } from 'drizzle-orm';
import type { Env } from '../types';
import { getDb, nowIso } from './db';
import { settings } from './schema';

const SETTINGS_KEY = 'oidc_signing_key';
const KEY_ALGORITHM = 'RSASSA-PKCS1-v1_5';
const HASH_ALGORITHM = 'SHA-256';

type RsaJwk = JsonWebKey & {
  kid?: string;
  kty: 'RSA';
  n?: string;
  e?: string;
};

export type OidcSigningKey = {
  kid: string;
  privateJwk: RsaJwk;
  publicJwk: RsaJwk;
  createdAt: string;
};

function stripPrivateJwkFields(jwk: RsaJwk): RsaJwk {
  return {
    kty: 'RSA',
    kid: jwk.kid,
    use: 'sig',
    alg: 'RS256',
    n: jwk.n,
    e: jwk.e,
  };
}

async function generateSigningKey(): Promise<OidcSigningKey> {
  const keyPair = (await crypto.subtle.generateKey(
    {
      name: KEY_ALGORITHM,
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: HASH_ALGORITHM,
    },
    true, // extractable
    ['sign', 'verify'],
  )) as CryptoKeyPair;

  const kid = crypto.randomUUID();
  const privateJwk = (await crypto.subtle.exportKey('jwk', keyPair.privateKey)) as RsaJwk;
  const publicJwk = (await crypto.subtle.exportKey('jwk', keyPair.publicKey)) as RsaJwk;

  privateJwk.kid = kid;
  publicJwk.kid = kid;

  return {
    kid,
    privateJwk,
    publicJwk: stripPrivateJwkFields(publicJwk),
    createdAt: nowIso(),
  };
}

export async function getOidcSigningKey(env: Env): Promise<OidcSigningKey> {
  const db = getDb(env);
  const row = await db.select().from(settings).where(eq(settings.key, SETTINGS_KEY)).get();

  if (row?.value) {
    try {
      return JSON.parse(row.value) as OidcSigningKey;
    } catch {
      // fall through to regenerate
    }
  }

  const key = await generateSigningKey();
  await db
    .insert(settings)
    .values({
      key: SETTINGS_KEY,
      value: JSON.stringify(key),
      updatedAt: key.createdAt,
    })
    .onConflictDoUpdate({
      target: settings.key,
      set: {
        value: JSON.stringify(key),
        updatedAt: key.createdAt,
      },
    });

  return key;
}

export async function getPrivateSigningKey(env: Env): Promise<CryptoKey> {
  const key = await getOidcSigningKey(env);
  return crypto.subtle.importKey(
    'jwk',
    key.privateJwk,
    {
      name: KEY_ALGORITHM,
      hash: HASH_ALGORITHM,
    },
    false,
    ['sign'],
  );
}

export async function getPublicJwks(env: Env): Promise<{ keys: RsaJwk[] }> {
  const key = await getOidcSigningKey(env);
  return { keys: [key.publicJwk] };
}
