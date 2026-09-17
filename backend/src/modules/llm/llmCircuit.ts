import type { Knex } from 'knex';
import { logger } from '../../config/logger.js';
import { localTimestamp } from '../../config/index.js';
import {
  type LlmErrorKind,
  type LlmRequestError,
  shouldPausePipeline,
} from './llmErrors.js';

const HEALTH_KEY = 'llm_provider_health';
const RECOVERY_FLAG_KEY = 'llm_quota_recovery_v1';

const MIN_PAUSE_MS = 2 * 60_000;
const MAX_PAUSE_MS = 60 * 60_000;
const AUTH_PAUSE_MS = 15 * 60_000;

export interface LlmProviderHealth {
  state: 'ok' | 'paused';
  reason: LlmErrorKind | null;
  message: string;
  pause_until: string | null;
  last_error_at: string | null;
  consecutive_failures: number;
  recovered_at: string | null;
}

const HEALTH_DEFAULTS: LlmProviderHealth = {
  state: 'ok',
  reason: null,
  message: '',
  pause_until: null,
  last_error_at: null,
  consecutive_failures: 0,
  recovered_at: null,
};

function parseHealth(raw: unknown): LlmProviderHealth {
  let value = raw;
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { return { ...HEALTH_DEFAULTS }; }
  }
  if (!value || typeof value !== 'object') return { ...HEALTH_DEFAULTS };
  return { ...HEALTH_DEFAULTS, ...(value as Partial<LlmProviderHealth>) };
}

export async function getLlmHealth(db: Knex): Promise<LlmProviderHealth> {
  try {
    const row = await db('app_config').where({ key: HEALTH_KEY }).first('value');
    if (!row) return { ...HEALTH_DEFAULTS };
    return parseHealth(row.value);
  } catch (err: any) {
    logger.warn(`[${localTimestamp()}] Failed to read LLM provider health: ${err.message}`);
    return { ...HEALTH_DEFAULTS };
  }
}

async function saveHealth(db: Knex, health: LlmProviderHealth): Promise<void> {
  const payload = JSON.stringify(health);
  await db.raw(`
    INSERT INTO app_config (key, value) VALUES (?, ?::jsonb)
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
  `, [HEALTH_KEY, payload]);
}

/** True when the pipeline must not call the LLM (quota/auth pause still in force). */
export function isLlmPaused(health: LlmProviderHealth, now = Date.now()): boolean {
  if (health.state !== 'paused' || !health.pause_until) return false;
  const until = Date.parse(health.pause_until);
  if (!Number.isFinite(until)) return false;
  return now < until;
}

export async function invalidateTemplateScoreCache(db: Knex): Promise<number> {
  const result = await db('message_templates')
    .whereNotNull('last_scored_at')
    .update({
      last_scored_at: null,
      cached_scores: null,
    });
  return Number(result) || 0;
}

function nextPauseMs(kind: LlmErrorKind, consecutiveFailures: number): number {
  if (kind === 'auth') return AUTH_PAUSE_MS;
  const exp = Math.min(MAX_PAUSE_MS, MIN_PAUSE_MS * (2 ** Math.max(0, consecutiveFailures - 1)));
  return exp;
}

/**
 * Record a provider failure. Quota and auth open a pause so we do not
 * keep marking events as scored with fake zeros.
 */
export async function recordLlmFailure(db: Knex, err: LlmRequestError): Promise<LlmProviderHealth> {
  const prev = await getLlmHealth(db);
  if (!shouldPausePipeline(err.kind)) {
    return prev;
  }
  const failures = (prev.consecutive_failures || 0) + 1;
  const pauseMs = nextPauseMs(err.kind, failures);
  const now = new Date();
  const health: LlmProviderHealth = {
    state: 'paused',
    reason: err.kind,
    message: err.userMessage,
    pause_until: new Date(now.getTime() + pauseMs).toISOString(),
    last_error_at: now.toISOString(),
    consecutive_failures: failures,
    recovered_at: prev.recovered_at,
  };
  await saveHealth(db, health);
  logger.warn(
    `[${localTimestamp()}] LLM provider paused (${err.kind}) for ${Math.round(pauseMs / 1000)}s ` +
    `(failure ${failures}). Events will stay unscored until the provider accepts requests again.`,
  );
  return health;
}

/**
 * Record a successful LLM call. If we were paused, clear template caches so
 * stale all-zero scores from the outage are not reused.
 */
export async function recordLlmSuccess(db: Knex): Promise<void> {
  const prev = await getLlmHealth(db);
  if (prev.state === 'ok' && (prev.consecutive_failures || 0) === 0) return;

  let cleared = 0;
  try {
    cleared = await invalidateTemplateScoreCache(db);
  } catch (err: any) {
    logger.warn(`[${localTimestamp()}] Failed to clear score cache on LLM recovery: ${err.message}`);
  }

  const health: LlmProviderHealth = {
    ...HEALTH_DEFAULTS,
    recovered_at: new Date().toISOString(),
  };
  await saveHealth(db, health);
  logger.info(
    `[${localTimestamp()}] LLM provider recovered after ${prev.consecutive_failures} failure(s); ` +
    `cleared ${cleared} cached template scores so analysis resumes with live scoring.`,
  );
}

/** Operator-triggered resume: clear the pause and drop cached scores. */
export async function resumeLlmProvider(db: Knex): Promise<{ health: LlmProviderHealth; cleared: number }> {
  const cleared = await invalidateTemplateScoreCache(db);
  const health: LlmProviderHealth = {
    ...HEALTH_DEFAULTS,
    recovered_at: new Date().toISOString(),
  };
  await saveHealth(db, health);
  logger.info(
    `[${localTimestamp()}] LLM provider pause cleared by operator; ${cleared} template caches invalidated.`,
  );
  return { health, cleared };
}

/**
 * One-time repair for the pre-fix behaviour: failed LLM calls wrote all-zero
 * scores into the template cache. If recent usage rows have zero tokens, the
 * cache is almost certainly poisoned and must be cleared so scoring resumes
 * after a balance refill.
 */
export async function runQuotaPoisonRecovery(db: Knex): Promise<void> {
  try {
    const flag = await db('app_config').where({ key: RECOVERY_FLAG_KEY }).first('key');
    if (flag) return;

    const since = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
    const poisoned = await db('llm_usage')
      .where({ run_type: 'per_event' })
      .where('token_input', 0)
      .where('token_output', 0)
      .where('created_at', '>=', since)
      .first('id');

    let cleared = 0;
    if (poisoned) {
      cleared = await invalidateTemplateScoreCache(db);
      logger.warn(
        `[${localTimestamp()}] Quota-poison recovery: cleared ${cleared} template score caches ` +
        `after detecting zero-token scoring runs (failed LLM calls that were stored as zeros).`,
      );
    }

    await db.raw(`
      INSERT INTO app_config (key, value) VALUES (?, ?::jsonb)
      ON CONFLICT (key) DO NOTHING
    `, [RECOVERY_FLAG_KEY, JSON.stringify({ done_at: new Date().toISOString(), cleared })]);
  } catch (err: any) {
    logger.warn(`[${localTimestamp()}] Quota-poison recovery skipped: ${err.message}`);
  }
}
