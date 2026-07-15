import type { Env } from '../types';
import { getPrivateSigningKey } from './oidc-keys';

function base64UrlEncode(input: string): string {
  return btoa(input).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export type IdTokenClaims = {
  iss: string;
  sub: string;
  aud: string;
  exp: number;
  iat: number;
  nonce?: string;
  email?: string;
  name?: string;
};

export async function createIdToken(env: Env, kid: string, claims: IdTokenClaims): Promise<string> {
  const privateKey = await getPrivateSigningKey(env);

  const header = base64UrlEncode(
    JSON.stringify({
      alg: 'RS256',
      typ: 'JWT',
      kid,
    }),
  );
  const payload = base64UrlEncode(JSON.stringify(claims));
  const signingInput = `${header}.${payload}`;

  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    privateKey,
    new TextEncoder().encode(signingInput),
  );

  const signatureB64 = base64UrlEncode(
    String.fromCharCode(...new Uint8Array(signature)),
  );

  return `${signingInput}.${signatureB64}`;
}
