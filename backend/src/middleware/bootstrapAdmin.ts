/**
 * Bootstrap the first administrator user.
 *
 * If no users exist in the database:
 * - If ADMIN_USERNAME / ADMIN_PASSWORD env vars are set, create the admin from those.
 * - Otherwise generate a random password and persist it into a local bootstrap file.
 */

import { v4 as uuidv4 } from 'uuid';
import { randomBytes } from 'node:crypto';
import type { Knex } from 'knex';
import { localTimestamp } from '../config/index.js';
import { hashPassword } from './passwords.js';
import { writeBootstrapSecret } from './bootstrapSecrets.js';

export async function ensureAdminUser(db: Knex): Promise<void> {
  // Only attempt if users table exists
  try {
    const exists = await db.schema.hasTable('users');
    if (!exists) return;
  } catch {
    return;
  }

  const existing = await db('users').first();
  if (existing) return; // Users already exist

  const username = (process.env.ADMIN_USERNAME || 'admin').trim().toLowerCase();
  const envPassword = process.env.ADMIN_PASSWORD;

  let password: string;
  let secretFilePath: string | null = null;
  if (envPassword && envPassword.length >= 12) {
    password = envPassword;
  } else {
    // Generate a strong random password
    password = randomBytes(16).toString('base64url').slice(0, 20) + '!A1a';
    secretFilePath = await writeBootstrapSecret('BOOTSTRAP ADMIN ACCOUNT', [
      { key: 'Username', value: username },
      { key: 'Password', value: password },
    ]);
  }

  const id = uuidv4();
  const passwordHash = await hashPassword(password);

  await db('users').insert({
    id,
    username,
    password_hash: passwordHash,
    display_name: 'Administrator',
    role: 'administrator',
    is_active: true,
    must_change_password: secretFilePath !== null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });

  if (secretFilePath) {
    console.log(`[${localTimestamp()}] Bootstrap admin user "${username}" created with an auto-generated password.`);
    console.log(`[${localTimestamp()}] Bootstrap credentials were saved to: ${secretFilePath}`);
    console.log(`[${localTimestamp()}] IMPORTANT: Use credentials once, then delete the bootstrap file.`);
  } else {
    console.log(`[${localTimestamp()}] Admin user "${username}" created from environment variables.`);
  }
}
