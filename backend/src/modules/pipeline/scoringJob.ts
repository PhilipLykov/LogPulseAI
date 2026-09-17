import { v4 as uuidv4 } from 'uuid';
import type { Knex } from 'knex';
import { localTimestamp } from '../../config/index.js';
import { extractTemplatesAndDedup, type TemplateRepresentative } from './dedup.js';
import { type LlmAdapter, type ScoreResult } from '../llm/adapter.js';
import { estimateCost } from '../llm/pricing.js';
import { CRITERIA } from '../../types/index.js';
import { resolveCustomPrompts, resolveCriterionGuidelines, resolveTaskModels } from '../llm/aiConfig.js';
import { buildScoringPrompt } from '../llm/adapter.js';
import { loadPrivacyFilterConfig, filterEventForLlm } from '../llm/llmPrivacyFilter.js';
import { getDefaultEventSource, getEventSource } from '../../services/eventSourceFactory.js';
import { loadNormalBehaviorTemplates, filterNormalBehaviorEvents } from './normalBehavior.js';
import { logger } from '../../config/logger.js';
import {
  classifyLlmException,
  shouldPausePipeline,
} from '../llm/llmErrors.js';
import {
  getLlmHealth,
  isLlmPaused,
  recordLlmFailure,
  recordLlmSuccess,
  invalidateTemplateScoreCache,
} from '../llm/llmCircuit.js';

// ── Token Optimization config type ──────────────────────────
export interface TokenOptimizationConfig {
  score_cache_enabled: boolean;
  score_cache_ttl_minutes: number;
  severity_filter_enabled: boolean;
  severity_skip_levels: string[];
  severity_default_score: number;
  message_max_length: number;
  scoring_batch_size: number;
  low_score_auto_skip_enabled: boolean;
  low_score_threshold: number;
  low_score_min_scorings: number;
  meta_max_events: number;
  meta_prioritize_high_scores: boolean;
  /** O1: Skip meta-analysis LLM call when all events in window scored 0. */
  skip_zero_score_meta: boolean;
  /** O2: Filter zero-score events from meta-analysis prompt to save tokens. */
  filter_zero_score_meta_events: boolean;
}

const DEFAULT_TOKEN_OPT: TokenOptimizationConfig = {
  score_cache_enabled: true,
  score_cache_ttl_minutes: 360,
  severity_filter_enabled: false,
  severity_skip_levels: ['debug'],
  severity_default_score: 0,
  message_max_length: 512,
  scoring_batch_size: 20,
  low_score_auto_skip_enabled: false,
  low_score_threshold: 0.05,
  low_score_min_scorings: 5,
  meta_max_events: 200,
  meta_prioritize_high_scores: true,
  skip_zero_score_meta: true,
  filter_zero_score_meta_events: true,
};

/** Load token optimization config from app_config, with defaults. */
export async function loadTokenOptConfig(db: Knex): Promise<TokenOptimizationConfig> {
  try {
    const row = await db('app_config').where({ key: 'token_optimization' }).first('value');
    if (!row) return { ...DEFAULT_TOKEN_OPT };
    let parsed = row.value;
    if (typeof parsed === 'string') {
      try { parsed = JSON.parse(parsed); } catch { return { ...DEFAULT_TOKEN_OPT }; }
    }
    // Merge with defaults so any new keys added in future migrations are present
    return { ...DEFAULT_TOKEN_OPT, ...(parsed as Partial<TokenOptimizationConfig>) };
  } catch {
    return { ...DEFAULT_TOKEN_OPT };
  }
}

// ── Helpers ─────────────────────────────────────────────────

// ── Orphan fragment detection ────────────────────────────────
// Short messages that look like SQL keywords, tab-prefixed continuations,
// or "Process NNN" lines are likely fragments from multiline reassembly
// that slipped through. Scoring them wastes LLM tokens and produces noise.

const SQL_FRAGMENT_RE = /^(SELECT|FROM|JOIN|LEFT\s+JOIN|INNER\s+JOIN|RIGHT\s+JOIN|CROSS\s+JOIN|WHERE|AND|OR|ON|ORDER\s+BY|GROUP\s+BY|HAVING|UNION|INSERT|UPDATE|DELETE|SET|VALUES|INTO|LIMIT|OFFSET|AS|CASE|WHEN|THEN|ELSE|END|WITH|RETURNING|LATERAL|COALESCE|EXISTS|NOT|IN|IS|NULL|LIKE|BETWEEN|DISTINCT|ALL|ANY|CREATE|ALTER|DROP|INDEX|TABLE|CONSTRAINT|PRIMARY|FOREIGN|REFERENCES|CASCADE|BEGIN|COMMIT|ROLLBACK|EXPLAIN|ANALYZE)\b/i;
const PROCESS_FRAGMENT_RE = /^Process\s+\d+/;

function isOrphanFragment(message: string | undefined | null): boolean {
  if (!message || message.length > 120) return false;
  const trimmed = message.trim();
  if (trimmed.length < 5) return true;
  if (/^#011/.test(trimmed) || /^\t/.test(trimmed)) return true;
  if (SQL_FRAGMENT_RE.test(trimmed)) return true;
  if (PROCESS_FRAGMENT_RE.test(trimmed)) return true;
  return false;
}

/** Build an empty (zero) ScoreResult. */
function emptyScoreResult(defaultVal = 0): ScoreResult {
  return {
    it_security: defaultVal,
    performance_degradation: defaultVal,
    failure_prediction: defaultVal,
    anomaly: defaultVal,
    compliance_audit: defaultVal,
    operational_risk: defaultVal,
  };
}

/** Compute the max criterion value from a ScoreResult. */
function maxScore(s: ScoreResult): number {
  return Math.max(
    s.it_security, s.performance_degradation, s.failure_prediction,
    s.anomaly, s.compliance_audit, s.operational_risk,
  );
}

/** Truncate a message to maxLen, appending a marker if truncated. */
function truncateMessage(msg: string, maxLen: number): string {
  if (maxLen <= 0 || msg.length <= maxLen) return msg;
  return msg.slice(0, maxLen) + ' [...truncated]';
}

/** Default chunk size for fetching unscored events per iteration. */
const DEFAULT_CHUNK_SIZE = 5000;

/** Maximum wall-clock time (ms) for a single scoring job invocation. */
const MAX_SCORING_JOB_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Per-event scoring job with token optimisation.
 *
 * Processes ALL unscored events by looping in chunks. Template deduplication
 * ensures that LLM cost scales with unique message patterns, not raw event
 * count — 100k events with 50 unique patterns = ~3 LLM API calls.
 *
 * Pipeline per chunk:
 * 1. Fetch unscored events (chunked per system).
 * 2. Run dedup / template extraction.
 * 3. Partition templates: severity-skip → cache-hit → low-score-skip → needs LLM.
 * 4. Score remaining via LLM (batched, messages truncated).
 * 5. Write event_scores for ALL templates (cached + LLM).
 * 6. Update template cache columns.
 * 7. Track LLM usage with optimisation stats.
 *
 * The `chunkSize` option controls how many events are fetched per iteration
 * (for memory management). The job loops until no unscored events remain
 * or the time guard (10 min) fires.
 */
export async function runPerEventScoringJob(
  db: Knex,
  llm: LlmAdapter,
  options?: { chunkSize?: number; systemId?: string; normalizeSql?: boolean },
): Promise<{ scored: number; templates: number; errors: number; llmPaused: boolean }> {
  const chunkSize = options?.chunkSize ?? DEFAULT_CHUNK_SIZE;
  const normalizeSql = options?.normalizeSql ?? false;
  const jobStart = Date.now();

  logger.debug(`[${localTimestamp()}] Per-event scoring job started (chunkSize=${chunkSize})`);

  const health = await getLlmHealth(db);
  if (isLlmPaused(health)) {
    logger.warn(
      `[${localTimestamp()}] Per-event scoring skipped: LLM provider paused` +
      `${health.reason ? ` (${health.reason})` : ''} until ${health.pause_until}. ` +
      `Events remain unscored so they can be analysed after the balance/key is restored.`,
    );
    return { scored: 0, templates: 0, errors: 0, llmPaused: true };
  }

  if (health.state === 'paused' || (health.consecutive_failures || 0) > 0) {
    try {
      const cleared = await invalidateTemplateScoreCache(db);
      logger.info(
        `[${localTimestamp()}] LLM probe run: cleared ${cleared} cached template scores before retrying the provider.`,
      );
    } catch (err: any) {
      logger.warn(`[${localTimestamp()}] LLM probe cache clear failed: ${err.message}`);
    }
  }

  // ── Load configs (once per job) ─────────────────────────
  const customPrompts = await resolveCustomPrompts(db);
  const criterionGuidelines = await resolveCriterionGuidelines(db);
  const opt = await loadTokenOptConfig(db);
  const effectiveScoringPrompt = customPrompts.scoringSystemPrompt
    ?? buildScoringPrompt(Object.keys(criterionGuidelines).length > 0 ? criterionGuidelines : undefined);
  const batchSize = Math.max(1, Math.min(opt.scoring_batch_size, 100));
  const normalTemplates = await loadNormalBehaviorTemplates(db, options?.systemId);

  // Track ES-backed systems once; cache system metadata and source labels
  const esSystemIds = new Set<string>();
  const allSystems = options?.systemId
    ? [await db('monitored_systems').where({ id: options.systemId }).first()]
    : await db('monitored_systems').select('*');
  for (const sys of allSystems) {
    if (sys?.event_source === 'elasticsearch') esSystemIds.add(sys.id);
  }

  // Cache per-system metadata and source labels (avoids repeated DB queries in inner loop)
  const systemCache = new Map<string, { description: string; sourceLabels: string[] }>();
  for (const sys of allSystems) {
    if (!sys) continue;
    const sources = await db('log_sources').where({ system_id: sys.id }).select('label');
    systemCache.set(sys.id, {
      description: sys.description ?? '',
      sourceLabels: sources.map((s: any) => s.label),
    });
  }

  const privacyConfig = await loadPrivacyFilterConfig(db);
  const taskModels = await resolveTaskModels(db);

  let totalScored = 0;
  let totalTemplates = 0;
  let totalErrors = 0;
  let totalTokenInput = 0;
  let totalTokenOutput = 0;
  let totalRequests = 0;
  let usedModel = '';
  let iterations = 0;
  let llmPaused = false;

  // ── Main loop: keep processing until all events are scored ──
  while (true) {
    // Time guard: stop if we've been running too long
    if (Date.now() - jobStart > MAX_SCORING_JOB_MS) {
      logger.info(
        `[${localTimestamp()}] Per-event scoring: time guard fired after ${iterations} iterations ` +
        `(${totalScored} events scored). Remaining events will be scored next run.`,
      );
      break;
    }

    // ── 1. Fetch unscored events per system ─────────────────
    let unscoredEvents: any[] = [];

    if (options?.systemId) {
      const sys = allSystems[0];
      const es = sys ? getEventSource(sys, db) : getDefaultEventSource(db);
      unscoredEvents = await es.getUnscoredEvents(options.systemId, chunkSize);
    } else {
      for (const sys of allSystems) {
        if (!sys) continue;
        const es = getEventSource(sys, db);
        const batch = await es.getUnscoredEvents(sys.id, chunkSize);
        unscoredEvents.push(...batch);
      }
    }

    if (unscoredEvents.length === 0) break; // All events scored

    const fetchedCount = unscoredEvents.length;

    // ── 1b. Exclude normal-behavior events ──────────────────
    if (normalTemplates.length > 0) {
      const { filtered, excluded, excludedCount } = filterNormalBehaviorEvents(unscoredEvents, normalTemplates);
      if (excludedCount > 0) {
        logger.debug(
          `[${localTimestamp()}] Per-event scoring: ${excludedCount} events excluded as normal behavior`,
        );
        await markEventsScored(db, excluded, esSystemIds);
        unscoredEvents = filtered;
      }
    }

    // ── 1c. Filter orphan fragments ─────────────────────────
    const fragmentExcluded: any[] = [];
    unscoredEvents = unscoredEvents.filter((evt: any) => {
      if (isOrphanFragment(evt.message)) {
        fragmentExcluded.push(evt);
        return false;
      }
      return true;
    });
    if (fragmentExcluded.length > 0) {
      logger.debug(
        `[${localTimestamp()}] Per-event scoring: ${fragmentExcluded.length} orphan fragments skipped`,
      );
      await markEventsScored(db, fragmentExcluded.map((e: any) => ({ id: e.id, system_id: e.system_id })), esSystemIds);
    }

    if (unscoredEvents.length === 0) {
      // Only non-scorable events in this chunk — loop to check for more
      iterations++;
      continue;
    }

    const unscoredEventIds = new Set(unscoredEvents.map((e: any) => e.id));

    // ── 2. Dedup / template extraction ──────────────────────
    const representatives = await extractTemplatesAndDedup(db, unscoredEvents, esSystemIds, { normalizeSql });
    const eventMap = new Map(unscoredEvents.map((e: any) => [e.id, e]));

    // ── 3. Partition templates by optimisation strategy ──────
    const templateIds = representatives.map((r) => r.templateId);
    const templateMeta = new Map<string, {
      last_scored_at: string | null;
      cached_scores: any;
      score_count: number;
      avg_max_score: number | null;
    }>();

    if (templateIds.length > 0) {
      for (let i = 0; i < templateIds.length; i += 200) {
        const chunk = templateIds.slice(i, i + 200);
        const rows = await db('message_templates')
          .whereIn('id', chunk)
          .select('id', 'last_scored_at', 'cached_scores', 'score_count', 'avg_max_score');
        for (const r of rows) {
          templateMeta.set(r.id, {
            last_scored_at: r.last_scored_at,
            cached_scores: r.cached_scores,
            score_count: Number(r.score_count) || 0,
            avg_max_score: r.avg_max_score != null ? Number(r.avg_max_score) : null,
          });
        }
      }
    }

    const now = Date.now();
    const cacheTtlMs = opt.score_cache_ttl_minutes * 60 * 1000;
    const skipSeverities = new Set(
      (opt.severity_skip_levels ?? []).map((s: string) => s.toLowerCase()),
    );

    const severitySkipped: Array<{ rep: TemplateRepresentative; score: ScoreResult }> = [];
    const cacheHits: Array<{ rep: TemplateRepresentative; score: ScoreResult }> = [];
    const lowScoreSkipped: Array<{ rep: TemplateRepresentative; score: ScoreResult }> = [];
    const needsScoring: TemplateRepresentative[] = [];

    for (const rep of representatives) {
      const event = eventMap.get(rep.representativeEventId);
      const severity = (event?.severity ?? '').toLowerCase();

      if (opt.severity_filter_enabled && severity && skipSeverities.has(severity)) {
        severitySkipped.push({ rep, score: emptyScoreResult(opt.severity_default_score) });
        continue;
      }

      if (opt.score_cache_enabled) {
        const meta = templateMeta.get(rep.templateId);
        if (meta?.last_scored_at && meta.cached_scores) {
          const scoredAt = new Date(meta.last_scored_at).getTime();
          if (now - scoredAt < cacheTtlMs) {
            let cached = meta.cached_scores;
            if (typeof cached === 'string') {
              try { cached = JSON.parse(cached); } catch { cached = null; }
            }
            if (cached && typeof cached === 'object') {
              const scoreResult: ScoreResult = {
                it_security: Number(cached.it_security) || 0,
                performance_degradation: Number(cached.performance_degradation) || 0,
                failure_prediction: Number(cached.failure_prediction) || 0,
                anomaly: Number(cached.anomaly) || 0,
                compliance_audit: Number(cached.compliance_audit) || 0,
                operational_risk: Number(cached.operational_risk) || 0,
              };
              cacheHits.push({ rep, score: scoreResult });
              continue;
            }
          }
        }
      }

      if (opt.low_score_auto_skip_enabled) {
        const meta = templateMeta.get(rep.templateId);
        if (
          meta &&
          meta.score_count >= opt.low_score_min_scorings &&
          meta.avg_max_score !== null &&
          meta.avg_max_score < opt.low_score_threshold
        ) {
          lowScoreSkipped.push({ rep, score: emptyScoreResult(0) });
          continue;
        }
      }

      needsScoring.push(rep);
    }

    logger.debug(
      `[${localTimestamp()}] Token optimisation [iter ${iterations + 1}]: ${representatives.length} templates → ` +
      `${severitySkipped.length} sev-skip, ${cacheHits.length} cache, ` +
      `${lowScoreSkipped.length} low-skip, ${needsScoring.length} LLM`,
    );

    // ── 4. Collect all score writes (skipped/cached + LLM) ──
    let chunkScored = 0;
    const allScoredEvents: Array<{ id: string; system_id: string }> = [];
    const pendingScoreWrites: Array<{ eventId: string; scores: ScoreResult }> = [];

    const allSkipped = [...severitySkipped, ...cacheHits, ...lowScoreSkipped];
    for (const { rep, score } of allSkipped) {
      const sysId = rep.systemId ?? '';
      for (const eid of rep.eventIds) {
        if (unscoredEventIds.has(eid)) {
          pendingScoreWrites.push({ eventId: eid, scores: score });
          allScoredEvents.push({ id: eid, system_id: sysId });
          chunkScored++;
        }
      }
    }

    // ── 5. Score remaining templates via LLM ────────────────
    const freshScores = new Map<string, ScoreResult>();

    for (let i = 0; i < needsScoring.length; i += batchSize) {
      if (llmPaused) break;
      const batch = needsScoring.slice(i, i + batchSize);
      const systemIds = [...new Set(
        batch.map((r) => r.systemId).filter((id): id is string => id !== null && id !== undefined && id !== ''),
      )];

      for (const systemId of systemIds) {
        if (llmPaused) break;
        const systemBatch = batch.filter((r) => r.systemId === systemId);
        if (systemBatch.length === 0) continue;

        try {
          const cached = systemCache.get(systemId) ?? { description: '', sourceLabels: [] };

          const eventsForLlm = systemBatch.map((r) => {
            const event = eventMap.get(r.representativeEventId);
            const raw = {
              message: truncateMessage(r.representativeMessage, opt.message_max_length),
              severity: event?.severity,
              host: event?.host,
              source_ip: event?.source_ip,
              program: event?.program,
            };
            return filterEventForLlm(raw, privacyConfig);
          });

          const { scores, usage } = await llm.scoreEvents(
            eventsForLlm,
            cached.description,
            cached.sourceLabels,
            {
              systemPrompt: effectiveScoringPrompt,
              modelOverride: taskModels.scoring_model || undefined,
            },
          );

          await recordLlmSuccess(db);

          totalTokenInput += usage.token_input;
          totalTokenOutput += usage.token_output;
          totalRequests += usage.request_count;
          if (!usedModel && usage.model) usedModel = usage.model;

          for (let j = 0; j < systemBatch.length; j++) {
            const rep = systemBatch[j];
            const scoreResult = scores[j];

            if (!scoreResult) {
              logger.warn(
                `[${localTimestamp()}] LLM returned ${scores.length} scores for ${systemBatch.length} templates. Template ${j} has no score.`,
              );
              totalErrors++;
              continue;
            }

            freshScores.set(rep.templateId, scoreResult);

            const repSysId = rep.systemId ?? '';
            for (const eid of rep.eventIds) {
              if (unscoredEventIds.has(eid)) {
                pendingScoreWrites.push({ eventId: eid, scores: scoreResult });
                allScoredEvents.push({ id: eid, system_id: repSysId });
                chunkScored++;
              }
            }
          }
        } catch (err) {
          const classified = classifyLlmException(err);
          logger.error(
            `[${localTimestamp()}] Per-event scoring error for system ${systemId} (${classified.kind}): ${classified.message}`,
          );
          totalErrors += systemBatch.length;
          if (shouldPausePipeline(classified.kind)) {
            await recordLlmFailure(db, classified);
            llmPaused = true;
            break;
          }
        }
      }
    }

    // ── 5b. Flush all event scores in bulk ───────────────────
    let bulkWriteOk = true;
    try {
      await writeBulkEventScores(db, pendingScoreWrites);
    } catch (err) {
      bulkWriteOk = false;
      logger.error(`[${localTimestamp()}] Bulk event score write failed:`, err);
      totalErrors += pendingScoreWrites.length;
    }

    // ── 5c. Mark all processed events as scored ──────────────
    // Skip marking if the bulk write failed — events need to be re-processed
    if (bulkWriteOk) {
      await markEventsScored(db, allScoredEvents, esSystemIds);
    }

    // ── 6. Batch-update template cache columns ───────────────
    if (freshScores.size > 0) {
      try {
        await batchUpdateTemplateCache(db, freshScores, templateMeta);
      } catch (err) {
        logger.warn(`[${localTimestamp()}] Batch template cache update failed:`, err);
      }
    }

    totalScored += chunkScored;
    totalTemplates += representatives.length;
    iterations++;

    // Quota/auth pause: stop consuming further chunks so events stay unscored.
    if (llmPaused) break;

    // If the DB returned fewer events than requested, the backlog is exhausted
    if (fetchedCount < chunkSize) break;
  }

  // ── 7. Track LLM usage (once per job, aggregated) ───────
  if (totalRequests > 0) {
    await db('llm_usage').insert({
      id: uuidv4(),
      run_type: 'per_event',
      model: usedModel || null,
      system_id: options?.systemId ?? null,
      event_count: totalScored,
      token_input: totalTokenInput,
      token_output: totalTokenOutput,
      request_count: totalRequests,
      cost_estimate: usedModel ? estimateCost(totalTokenInput, totalTokenOutput, usedModel) : null,
    });
  }

  const elapsed = Date.now() - jobStart;
  logger.debug(
    `[${localTimestamp()}] Per-event scoring complete in ${elapsed}ms: scored=${totalScored}, ` +
    `templates=${totalTemplates}, errors=${totalErrors}, iterations=${iterations}, ` +
    `tokens=${totalTokenInput + totalTokenOutput}`,
  );

  return { scored: totalScored, templates: totalTemplates, errors: totalErrors, llmPaused };
}

/**
 * Bulk-write non-zero event scores. Generates all rows for all events×criteria
 * in one pass, then flushes in chunked multi-row INSERTs (PG max ~6500 params).
 */
async function writeBulkEventScores(
  db: Knex,
  entries: Array<{ eventId: string; scores: ScoreResult }>,
): Promise<void> {
  if (entries.length === 0) return;

  const allRows: Array<[string, string, number, number, string]> = [];
  for (const { eventId, scores } of entries) {
    for (const c of CRITERIA) {
      const score = Number((scores as any)[c.slug]) || 0;
      if (score > 0) {
        allRows.push([uuidv4(), eventId, c.id, score, 'event']);
      }
    }
  }

  if (allRows.length === 0) return;

  const PARAMS_PER_ROW = 5;
  const MAX_PARAMS = 6000;
  const CHUNK = Math.floor(MAX_PARAMS / PARAMS_PER_ROW);

  for (let i = 0; i < allRows.length; i += CHUNK) {
    const chunk = allRows.slice(i, i + CHUNK);
    const placeholders = chunk.map(() => '(?, ?, ?, ?, ?)').join(', ');
    const values = chunk.flatMap((r) => r);
    await db.raw(`
      INSERT INTO event_scores (id, event_id, criterion_id, score, score_type)
      VALUES ${placeholders}
      ON CONFLICT (event_id, criterion_id, score_type) DO NOTHING
    `, values);
  }
}

/**
 * Batch-update template cache columns (last_scored_at, cached_scores, etc.)
 * in a single UPDATE ... FROM (VALUES ...) statement instead of per-template UPDATEs.
 */
async function batchUpdateTemplateCache(
  db: Knex,
  freshScores: Map<string, ScoreResult>,
  templateMeta: Map<string, { score_count: number; avg_max_score: number | null }>,
): Promise<void> {
  if (freshScores.size === 0) return;

  const nowIso = new Date().toISOString();
  const rows: Array<[string, string, string, number, number]> = [];

  for (const [templateId, scoreResult] of freshScores) {
    const ms = maxScore(scoreResult);
    const meta = templateMeta.get(templateId);
    const prevCount = meta?.score_count ?? 0;
    const prevAvg = meta?.avg_max_score ?? 0;
    const newCount = prevCount + 1;
    const newAvg = (prevAvg * prevCount + ms) / newCount;

    rows.push([
      templateId,
      nowIso,
      JSON.stringify(scoreResult),
      newCount,
      Number(newAvg.toFixed(4)),
    ]);
  }

  const PARAMS_PER_ROW = 5;
  const MAX_PARAMS = 6000;
  const CHUNK = Math.floor(MAX_PARAMS / PARAMS_PER_ROW);

  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const placeholders = chunk.map(() => '(?::uuid, ?::timestamptz, ?::jsonb, ?::int, ?::numeric)').join(', ');
    const values = chunk.flatMap((r) => r);
    await db.raw(`
      UPDATE message_templates AS mt
      SET last_scored_at = v.last_scored_at,
          cached_scores  = v.cached_scores,
          score_count    = v.score_count,
          avg_max_score  = v.avg_max_score
      FROM (VALUES ${placeholders})
        AS v(id, last_scored_at, cached_scores, score_count, avg_max_score)
      WHERE mt.id = v.id
    `, values);
  }
}

/**
 * Mark events as scored by setting scored_at timestamp.
 * This replaces the old approach of writing zero-score rows as a "processed" marker.
 *
 * Handles both PG events (updates `events.scored_at`) and ES events
 * (upserts `es_event_metadata.scored_at`).
 */
async function markEventsScored(
  db: Knex,
  events: Array<{ id: string; system_id: string }>,
  esSystemIds: Set<string>,
): Promise<void> {
  if (events.length === 0) return;
  const CHUNK = 5000;
  const now = new Date().toISOString();

  // Split into PG events and ES events
  const pgIds: string[] = [];
  const esBySystem = new Map<string, string[]>();

  for (const evt of events) {
    if (esSystemIds.has(evt.system_id)) {
      let list = esBySystem.get(evt.system_id);
      if (!list) { list = []; esBySystem.set(evt.system_id, list); }
      list.push(evt.id);
    } else {
      pgIds.push(evt.id);
    }
  }

  // PG events: update events.scored_at
  for (let i = 0; i < pgIds.length; i += CHUNK) {
    const chunk = pgIds.slice(i, i + CHUNK);
    await db('events').whereIn('id', chunk).update({ scored_at: now });
  }

  // ES events: upsert es_event_metadata.scored_at
  for (const [systemId, ids] of esBySystem) {
    for (let i = 0; i < ids.length; i += CHUNK) {
      const chunk = ids.slice(i, i + CHUNK);
      const placeholders = chunk.map(() => '(?, ?, ?)').join(', ');
      const values = chunk.flatMap((eid) => [systemId, eid, now]);
      await db.raw(`
        INSERT INTO es_event_metadata (system_id, es_event_id, scored_at)
        VALUES ${placeholders}
        ON CONFLICT (system_id, es_event_id)
        DO UPDATE SET scored_at = EXCLUDED.scored_at
      `, values);
    }
  }
}
