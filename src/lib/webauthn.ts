import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import type {
  AuthenticationResponseJSON,
  AuthenticatorTransportFuture,
  RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { eq } from 'drizzle-orm';
import type { Env, User } from '../types';
import { getDb } from './db';
import { passkeys } from './schema';
import { deleteChallenge, getChallenge, newChallengeId, putChallenge } from './challenge';

function base64urlToUint8Array(base64url: string): Uint8Array<ArrayBuffer> {
  const base64 = base64url.replace(/-/g, '+').replace(/_/g, '/');
  const pad = base64.length % 4 === 0 ? '' : '='.repeat(4 - (base64.length % 4));
  const binary = atob(base64 + pad);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function uint8ArrayToBase64url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function getWebAuthnConfig(env: Env) {
  return {
    rpID: env.RP_ID,
    rpName: env.RP_NAME,
    expectedOrigin: env.ORIGIN,
  };
}

export async function createRegistrationOptions(env: Env, user: User, existingIds: string[] = []) {
  const { rpID, rpName } = getWebAuthnConfig(env);
  const options = await generateRegistrationOptions({
    rpName,
    rpID,
    userName: user.email,
    userDisplayName: user.name,
    userID: new TextEncoder().encode(user.id),
    attestationType: 'none',
    excludeCredentials: existingIds.map((id) => ({ id, transports: [] })),
    authenticatorSelection: {
      residentKey: 'required',
      userVerification: 'required',
    },
  });

  const challengeId = newChallengeId();
  await putChallenge(env.CHALLENGES, challengeId, {
    id: challengeId,
    type: 'registration',
    userId: user.id,
    challenge: options.challenge,
    createdAt: Date.now(),
  });

  return { options, challengeId };
}

export async function verifyRegistration(
  env: Env,
  user: User,
  challengeId: string,
  response: RegistrationResponseJSON,
) {
  const stored = await getChallenge(env.CHALLENGES, challengeId);
  if (!stored || stored.type !== 'registration' || stored.userId !== user.id) {
    throw new Error('Invalid or expired challenge');
  }

  const { rpID, expectedOrigin } = getWebAuthnConfig(env);
  const verification = await verifyRegistrationResponse({
    response,
    expectedChallenge: stored.challenge,
    expectedOrigin,
    expectedRPID: rpID,
  });

  await deleteChallenge(env.CHALLENGES, challengeId);

  if (!verification.verified || !verification.registrationInfo) {
    throw new Error('Registration verification failed');
  }

  const { credential, credentialDeviceType, credentialBackedUp, aaguid } =
    verification.registrationInfo;

  return {
    credentialId: credential.id,
    publicKey: uint8ArrayToBase64url(credential.publicKey),
    counter: credential.counter,
    deviceType: credentialDeviceType,
    backedUp: credentialBackedUp,
    transports: credential.transports ?? [],
    aaguid: aaguid ?? null,
  };
}

export async function createAuthenticationOptions(env: Env) {
  const { rpID } = getWebAuthnConfig(env);
  const options = await generateAuthenticationOptions({
    rpID,
    userVerification: 'required',
  });

  const challengeId = newChallengeId();
  await putChallenge(env.CHALLENGES, challengeId, {
    id: challengeId,
    type: 'authentication',
    userId: '',
    challenge: options.challenge,
    createdAt: Date.now(),
  });

  return { options, challengeId };
}

export async function verifyAuthentication(
  env: Env,
  challengeId: string,
  response: AuthenticationResponseJSON,
) {
  const stored = await getChallenge(env.CHALLENGES, challengeId);
  if (!stored || stored.type !== 'authentication') {
    throw new Error('Invalid or expired challenge');
  }

  const db = getDb(env);
  const passkeyRow = await db
    .select()
    .from(passkeys)
    .where(eq(passkeys.credentialId, response.id))
    .get();

  if (!passkeyRow) {
    throw new Error('Passkey not found');
  }

  const { rpID, expectedOrigin } = getWebAuthnConfig(env);
  const verification = await verifyAuthenticationResponse({
    response,
    expectedChallenge: stored.challenge,
    expectedOrigin,
    expectedRPID: rpID,
    credential: {
      id: passkeyRow.credentialId,
      publicKey: base64urlToUint8Array(passkeyRow.publicKey),
      counter: passkeyRow.counter,
      transports: passkeyRow.transports
        ? (JSON.parse(passkeyRow.transports) as AuthenticatorTransportFuture[])
        : undefined,
    },
  });

  await deleteChallenge(env.CHALLENGES, challengeId);

  if (!verification.verified) {
    throw new Error('Authentication verification failed');
  }

  return {
    userId: passkeyRow.userId,
    newCounter: verification.authenticationInfo.newCounter,
    passkeyId: passkeyRow.id,
  };
}
