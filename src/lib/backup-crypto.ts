const PBKDF2_ITERATIONS = 310_000;
const SALT_BYTES = 16;
const IV_BYTES = 12;

function bytesToB64(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function b64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

async function deriveKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt,
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256',
    },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export type EncryptedBackupEnvelope = {
  v: 1;
  kind: 'pauth-backup-encrypted-v1';
  kdf: 'PBKDF2';
  iter: number;
  salt: string;
  iv: string;
  ciphertext: string;
};

export async function encryptBackupPayload(plaintext: string, password: string): Promise<string> {
  if (!password || password.length < 8) {
    throw new Error('密码至少 8 个字符');
  }
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const key = await deriveKey(password, salt);
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(plaintext),
  );
  const envelope: EncryptedBackupEnvelope = {
    v: 1,
    kind: 'pauth-backup-encrypted-v1',
    kdf: 'PBKDF2',
    iter: PBKDF2_ITERATIONS,
    salt: bytesToB64(salt),
    iv: bytesToB64(iv),
    ciphertext: bytesToB64(new Uint8Array(ciphertext)),
  };
  return JSON.stringify(envelope);
}

export async function decryptBackupPayload(bundleText: string, password: string): Promise<string> {
  if (!password) {
    throw new Error('请输入密码');
  }
  let envelope: EncryptedBackupEnvelope;
  try {
    envelope = JSON.parse(bundleText) as EncryptedBackupEnvelope;
  } catch {
    throw new Error('备份文件格式无效');
  }
  if (envelope.kind !== 'pauth-backup-encrypted-v1' || envelope.v !== 1) {
    throw new Error('不支持的备份版本');
  }
  const salt = b64ToBytes(envelope.salt);
  const iv = b64ToBytes(envelope.iv);
  const ciphertext = b64ToBytes(envelope.ciphertext);
  const key = await deriveKey(password, salt);
  try {
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
    return new TextDecoder().decode(plain);
  } catch {
    throw new Error('密码错误或备份文件已损坏');
  }
}
