import { randomBytes, createHash } from 'node:crypto';
import { v4 as uuidv4 } from 'uuid';
import type { Knex } from 'knex';
import type { ApiKeyScope, ApiKeyRow } from '../types/index.js';
import { localTimestamp } from '../config/index.js';
import { writeBootstrapSecret } from './bootstrapSecrets.js';

/**
 * Hash an API key using SHA-256.
 * API keys are high-entropy random strings, so SHA-256 is appropriate
 * (unlike passwords which need bcrypt/argon2). See OWASP guidance.
 */
export function hashApiKey(plainKey: string): string {
  return createHash('sha256').update(plainKey).digest('hex');
}

/** Generate a cryptographically random API key (48 bytes → 96-char hex). */
export function generateApiKey(): string {
  return randomBytes(48).toString('hex');
}

/** Create an API key row and return the plain key (shown only once). */
export async function createApiKey(
  db: Knex,
  name: string,
  scope: ApiKeyScope,
): Promise<{ id: string; plainKey: string }> {
  const id = uuidv4();
  const plainKey = generateApiKey();
  const keyHash = hashApiKey(plainKey);

  await db('api_keys').insert({ id, key_hash: keyHash, scope, name });
  console.log(`[${localTimestamp()}] API key created: name="${name}", scope="${scope}", id=${id}`);
  return { id, plainKey };
}

/** Look up an API key by its SHA-256 hash. Returns the row or undefined. */
export async function findApiKeyByHash(db: Knex, plainKey: string): Promise<ApiKeyRow | undefined> {
  const keyHash = hashApiKey(plainKey);
  return db('api_keys').where({ key_hash: keyHash }).first();
}

/**
 * Ensure at least one admin key exists. If ADMIN_API_KEY env is set,
 * insert it (idempotent). Otherwise generate one and persist it into a local
 * bootstrap file (never printed in logs).
 */
export async function ensureAdminKey(db: Knex, envKey?: string): Promise<void> {
  const existing = await db('api_keys').where({ scope: 'admin' }).first();
  if (existing) return;

  if (envKey) {
    const id = uuidv4();
    const keyHash = hashApiKey(envKey);
    await db('api_keys').insert({ id, key_hash: keyHash, scope: 'admin', name: 'env-admin' });
    console.log(`[${localTimestamp()}] Admin API key loaded from environment.`);
  } else {
    const id = uuidv4();
    const plainKey = generateApiKey();
    const keyHash = hashApiKey(plainKey);
    const secretFilePath = await writeBootstrapSecret('BOOTSTRAP ADMIN API KEY', [
      { key: 'Scope', value: 'admin' },
      { key: 'Key', value: plainKey },
    ]);

    await db('api_keys').insert({ id, key_hash: keyHash, scope: 'admin', name: 'auto-admin' });

    console.log(`[${localTimestamp()}] Auto-generated admin API key created.`);
    console.log(`[${localTimestamp()}] Bootstrap credentials were saved to: ${secretFilePath}`);
    console.log(`[${localTimestamp()}] IMPORTANT: Use credentials once, then delete the bootstrap file.`);
  }
}
