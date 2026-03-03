import { open, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { localTimestamp } from '../config/index.js';

const DEFAULT_BOOTSTRAP_SECRET_FILE = path.join(process.cwd(), 'bootstrap-secrets.txt');

function resolveBootstrapSecretFile(): string {
  const fromEnv = process.env.BOOTSTRAP_SECRET_FILE?.trim();
  return fromEnv && fromEnv.length > 0 ? fromEnv : DEFAULT_BOOTSTRAP_SECRET_FILE;
}

/**
 * Persist one-time bootstrap secrets to a local file.
 * Secrets are never printed to logs.
 * The file is opened with mode 0o600 to avoid a TOCTOU window where
 * the secret is world-readable before chmod.
 */
export async function writeBootstrapSecret(
  title: string,
  lines: Array<{ key: string; value: string }>,
): Promise<string> {
  const filePath = resolveBootstrapSecretFile();
  await mkdir(path.dirname(filePath), { recursive: true });

  const block = [
    `[${localTimestamp()}] ${title}`,
    ...lines.map((entry) => `${entry.key}: ${entry.value}`),
    '',
  ].join('\n');

  let fh;
  try {
    fh = await open(filePath, 'a', 0o600);
    await fh.appendFile(block, 'utf8');
  } finally {
    await fh?.close();
  }
  return filePath;
}
