import 'dotenv/config';

/** Timestamp helper — uses config.tz (default Europe/Chisinau per user rule) */
export function localTimestamp(): string {
  const tz = process.env.TZ || 'Europe/Chisinau';
  return new Date().toLocaleString('sv-SE', { timeZone: tz }).replace(' ', 'T');
}

/**
 * Parse an integer from an env var with safe defaults.
 * Returns the fallback if the env var is empty, undefined, or non-numeric.
 */
function envInt(value: string | undefined, fallback: number): number {
  if (!value || value.trim() === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export const config = {
  host: process.env.HOST || '0.0.0.0',
  port: envInt(process.env.PORT, 3000),

  db: {
    host: process.env.DB_HOST || 'localhost',
    port: envInt(process.env.DB_PORT, 5432),
    database: process.env.DB_NAME || 'logpulse_ai',
    user: process.env.DB_USER || 'syslog_ai',
    password: process.env.DB_PASSWORD ?? '',
  },

  /** Initial admin API key (optional; generated on first run if missing) */
  adminApiKey: process.env.ADMIN_API_KEY ?? '',

  redaction: {
    enabled: (process.env.REDACTION_ENABLED ?? 'false').toLowerCase() === 'true',
    /** Extra patterns (comma-separated regexes) on top of built-in set */
    extraPatterns: process.env.REDACTION_PATTERNS
      ? process.env.REDACTION_PATTERNS.split(',').map((p) => p.trim())
      : [],
  },

  tz: process.env.TZ || 'Europe/Chisinau',
} as const;
