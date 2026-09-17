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
const RECOVERY_FLAG_V2_KEY = 'llm_quota_recovery_v2';

const MIN_PAUSE_MS = 2 * 60_000;
const MAX_PAUSE_MS = 60 * 60_000;
const AUTH_PAUSE_MS = 15 * 60_000;

/** Must match dashboard default score_display_window_days and scoring lookback. */
export const POISON_REPAIR_LOOKBACK_DAYS = 7;

/**
 * Written by skip_zero_score_meta when every event in a window has max score 0.
 * Poisoned quota-outage windows used the same text, so recovery deletes it.
 */
export const ZERO_SCORE_WINDOW_SUMMARY =
  'All events in this window scored as routine. No significant issues detected.';

export interface LlmProviderHealth {
  state: 'ok' | 'paused';
  reason: LlmErrorKind | null;
  message: string;
  pause_until: string | null;
  last_error_at: string | null;
  consecutive_failures: number;
  recovered_at: string | null;
}

export interface PoisonScoreRepairResult {
  skipped: boolean;
  templatesCleared: number;
  eventsReopened: number;
  esEventsReopened: number;
  windowsReopened: number;
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

function countFromRaw(result: { rows?: Array<{ cnt?: number }>; rowCount?: number }): number {
  const fromRow = Number(result.rows?.[0]?.cnt);
  if (Number.isFinite(fromRow)) return fromRow;
  return Number(result.rowCount) || 0;
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
  const repair = await repairPoisonedZeroScores(db);
  logger.info(
    `[${localTimestamp()}] LLM provider recovered after ${prev.consecutive_failures} failure(s); ` +
    `cleared ${cleared} cached template scores; reopened events=${repair.eventsReopened}, ` +
    `windows=${repair.windowsReopened}.`,
  );
}

/** Operator-triggered resume: clear the pause and drop poisoned scores. */
export async function resumeLlmProvider(db: Knex): Promise<{
  health: LlmProviderHealth;
  cleared: number;
  repair: PoisonScoreRepairResult;
}> {
  const cleared = await invalidateTemplateScoreCache(db);
  const repair = await repairPoisonedZeroScores(db);
  const health: LlmProviderHealth = {
    ...HEALTH_DEFAULTS,
    recovered_at: new Date().toISOString(),
  };
  await saveHealth(db, health);
  logger.info(
    `[${localTimestamp()}] LLM provider pause cleared by operator; ${cleared} template caches invalidated; ` +
    `reopened events=${repair.eventsReopened} es=${repair.esEventsReopened} windows=${repair.windowsReopened}.`,
  );
  return { health, cleared, repair };
}

/**
 * Reopen events and windows that were stored as all-zero / "routine" during a
 * provider outage. Template-cache clear alone is not enough: scored_at and
 * skip_zero_score_meta rows keep the dashboard at 0 until they are removed.
 *
 * Runs once (flag llm_quota_recovery_v2). Does not touch events that already
 * have a positive event_score.
 */
export async function repairPoisonedZeroScores(db: Knex): Promise<PoisonScoreRepairResult> {
  const empty: PoisonScoreRepairResult = {
    skipped: true,
    templatesCleared: 0,
    eventsReopened: 0,
    esEventsReopened: 0,
    windowsReopened: 0,
  };

  try {
    const flag = await db('app_config').where({ key: RECOVERY_FLAG_V2_KEY }).first('key');
    if (flag) return empty;

    const cutoff = new Date(
      Date.now() - POISON_REPAIR_LOOKBACK_DAYS * 24 * 60 * 60 * 1000,
    ).toISOString();

    const templatesCleared = await invalidateTemplateScoreCache(db);

    const eventsResult = await db.raw(`
      WITH reopened AS (
        UPDATE events e
        SET scored_at = NULL
        WHERE e.scored_at IS NOT NULL
          AND e.acknowledged_at IS NULL
          AND e.timestamp >= ?
          AND NOT EXISTS (
            SELECT 1 FROM event_scores es
            WHERE es.event_id = e.id::text
              AND es.score > 0
              AND es.score_type = 'event'
          )
        RETURNING e.id
      )
      SELECT COUNT(*)::int AS cnt FROM reopened
    `, [cutoff]);
    const eventsReopened = countFromRaw(eventsResult);

    let esEventsReopened = 0;
    const hasEsMeta = await db.schema.hasTable('es_event_metadata');
    if (hasEsMeta) {
      const esResult = await db.raw(`
        WITH reopened AS (
          UPDATE es_event_metadata m
          SET scored_at = NULL
          WHERE m.scored_at IS NOT NULL
            AND m.acknowledged_at IS NULL
            AND COALESCE(m.event_timestamp, m.scored_at, m.created_at) >= ?
            AND NOT EXISTS (
              SELECT 1 FROM event_scores es
              WHERE es.event_id = m.es_event_id
                AND es.score > 0
                AND es.score_type = 'event'
            )
          RETURNING m.es_event_id
        )
        SELECT COUNT(*)::int AS cnt FROM reopened
      `, [cutoff]);
      esEventsReopened = countFromRaw(esResult);
    }

    const windowsResult = await db.raw(`
      WITH zero_windows AS (
        SELECT w.id
        FROM windows w
        WHERE w.to_ts >= ?
          AND EXISTS (SELECT 1 FROM meta_results m WHERE m.window_id = w.id)
          AND (
            EXISTS (
              SELECT 1 FROM meta_results m
              WHERE m.window_id = w.id AND m.summary = ?
            )
            OR NOT EXISTS (
              SELECT 1 FROM effective_scores e
              WHERE e.window_id = w.id AND e.effective_value > 0
            )
          )
      ),
      del_eff AS (
        DELETE FROM effective_scores
        WHERE window_id IN (SELECT id FROM zero_windows)
        RETURNING window_id
      ),
      del_meta AS (
        DELETE FROM meta_results
        WHERE window_id IN (SELECT id FROM zero_windows)
        RETURNING window_id
      )
      SELECT COUNT(*)::int AS cnt FROM zero_windows
    `, [cutoff, ZERO_SCORE_WINDOW_SUMMARY]);
    const windowsReopened = countFromRaw(windowsResult);

    await db.raw(`
      INSERT INTO app_config (key, value) VALUES (?, ?::jsonb)
      ON CONFLICT (key) DO NOTHING
    `, [RECOVERY_FLAG_V2_KEY, JSON.stringify({
      done_at: new Date().toISOString(),
      templatesCleared,
      eventsReopened,
      esEventsReopened,
      windowsReopened,
    })]);

    logger.warn(
      `[${localTimestamp()}] Quota-poison recovery v2: cleared ${templatesCleared} template caches, ` +
      `reopened ${eventsReopened} PG events, ${esEventsReopened} ES events, ` +
      `${windowsReopened} all-zero analysis windows (lookback ${POISON_REPAIR_LOOKBACK_DAYS}d).`,
    );

    return {
      skipped: false,
      templatesCleared,
      eventsReopened,
      esEventsReopened,
      windowsReopened,
    };
  } catch (err: any) {
    logger.warn(`[${localTimestamp()}] Quota-poison recovery v2 skipped: ${err.message}`);
    return empty;
  }
}

/**
 * One-time repair for the pre-fix behaviour: failed LLM calls wrote all-zero
 * scores into the template cache. If recent usage rows have zero tokens, the
 * cache is almost certainly poisoned and must be cleared so scoring resumes
 * after a balance refill.
 *
 * v1 only cleared caches. v2 also reopens scored-at zeros and synthetic
 * "all routine" windows so the dashboard is not stuck at 0%.
 */
export async function runQuotaPoisonRecovery(db: Knex): Promise<void> {
  try {
    const flag = await db('app_config').where({ key: RECOVERY_FLAG_KEY }).first('key');
    if (!flag) {
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
    }
  } catch (err: any) {
    logger.warn(`[${localTimestamp()}] Quota-poison recovery skipped: ${err.message}`);
  }

  await repairPoisonedZeroScores(db);
}
