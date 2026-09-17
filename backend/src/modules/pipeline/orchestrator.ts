import type { Knex } from 'knex';
import { localTimestamp } from '../../config/index.js';
import { logger } from '../../config/logger.js';
import { type LlmAdapter, OpenAiAdapter } from '../llm/adapter.js';
import { resolveAiConfig } from '../llm/aiConfig.js';
import { recalcEffectiveScores } from '../events/recalcScores.js';
import { runPerEventScoringJob } from './scoringJob.js';
import { createWindows, getUnanalyzedWindows } from './windowing.js';
import { metaAnalyzeWindow, WindowNotReadyError } from './metaAnalyze.js';
import { evaluateAlerts } from '../alerting/evaluator.js';
import { runGroupingEngine } from '../discovery/groupingEngine.js';
import { getLlmHealth, isLlmPaused } from '../llm/llmCircuit.js';

/** Load pipeline config from app_config, falling back to defaults. */
async function loadPipelineConfig(db: Knex): Promise<{
  pipeline_min_interval_minutes: number;
  pipeline_max_interval_minutes: number;
  window_minutes: number;
  scoring_chunk_size: number;
  effective_score_meta_weight: number;
  normalize_sql_statements: boolean;
}> {
  const DEFAULTS = {
    pipeline_min_interval_minutes: 15,
    pipeline_max_interval_minutes: 120,
    window_minutes: 5,
    scoring_chunk_size: 5000,
    effective_score_meta_weight: 0.7,
    normalize_sql_statements: false,
  };
  try {
    const row = await db('app_config').where({ key: 'pipeline_config' }).first('value');
    if (!row) return DEFAULTS;
    const raw = typeof row.value === 'string' ? JSON.parse(row.value) : row.value;
    if (raw && typeof raw === 'object') {
      const merged = { ...DEFAULTS, ...(raw as Record<string, unknown>) };
      // Backward compat: migrate old scoring_limit_per_run → scoring_chunk_size
      if ((raw as any).scoring_limit_per_run && !(raw as any).scoring_chunk_size) {
        merged.scoring_chunk_size = Math.max(1000, Number((raw as any).scoring_limit_per_run) || DEFAULTS.scoring_chunk_size);
      }
      return merged as typeof DEFAULTS;
    }
    return DEFAULTS;
  } catch {
    return DEFAULTS;
  }
}

/**
 * Sync the adapter's config from the DB (app_config table), falling
 * back to environment variables. Called before each pipeline run so
 * changes made via the UI take effect without a restart.
 */
async function syncAdapterConfig(db: Knex, llm: OpenAiAdapter): Promise<void> {
  const cfg = await resolveAiConfig(db);
  llm.updateConfig({
    apiKey: cfg.apiKey,
    model: cfg.model,
    baseUrl: cfg.baseUrl,
    reasoningEffort: cfg.reasoningEffort,
  });
}

/**
 * Pipeline orchestrator: runs the full scoring pipeline periodically.
 *
 * 1. Per-event scoring (dedup + LLM)
 * 2. Create windows
 * 3. Meta-analyze each new window
 * 4. Evaluate alerts only for windows that were successfully meta-analyzed
 *
 * Call this on a schedule (e.g. every 5 minutes) or after ingest.
 */
export async function runPipeline(
  db: Knex,
  llm: LlmAdapter,
  options?: { windowMinutes?: number; wMeta?: number; chunkSize?: number },
): Promise<{ scored: number; windows: number; analyzed: number }> {
  const start = Date.now();
  logger.debug(`[${localTimestamp()}] Pipeline run started.`);

  try {
    // Load pipeline config from DB (runtime-configurable via UI)
    const pipeCfg = await loadPipelineConfig(db);

    // 1. Per-event scoring — processes ALL unscored events in a loop
    const scoringResult = await runPerEventScoringJob(db, llm, {
      chunkSize: options?.chunkSize ?? pipeCfg.scoring_chunk_size,
      normalizeSql: pipeCfg.normalize_sql_statements,
    });

    if (scoringResult.llmPaused) {
      const health = await getLlmHealth(db);
      logger.warn(
        `[${localTimestamp()}] Pipeline: skipping windowing and meta-analysis while LLM is paused` +
        `${health.pause_until ? ` until ${health.pause_until}` : ''}.`,
      );
      return { scored: scoringResult.scored, windows: 0, analyzed: 0 };
    }

    // 1b. Propagate new event scores into existing effective_scores
    if (scoringResult.scored > 0) {
      try {
        await recalcEffectiveScores(db, null);
      } catch (err) {
        logger.warn(`[${localTimestamp()}] Pipeline: recalcEffectiveScores failed:`, err);
      }
    }

    // 2. Create windows
    const windows = await createWindows(db, {
      windowMinutes: options?.windowMinutes ?? pipeCfg.window_minutes,
    });

    const pending = await getUnanalyzedWindows(db, { lookbackHours: 168, limit: 40 });
    const byId = new Map<string, { id: string; system_id: string; from_ts: string; to_ts: string }>();
    for (const w of [...windows, ...pending]) {
      byId.set(w.id, w);
    }
    const toAnalyze = [...byId.values()];

    // 3. Meta-analyze each new or previously unfinished window
    const analyzedWindows: typeof windows = [];
    for (const w of toAnalyze) {
      try {
        await metaAnalyzeWindow(db, llm, w.id, {
          wMeta: options?.wMeta ?? pipeCfg.effective_score_meta_weight,
        });
        analyzedWindows.push(w);
      } catch (err) {
        if (err instanceof WindowNotReadyError) {
          logger.info(`[${localTimestamp()}] Meta-analyze deferred for window ${w.id}: ${err.message}`);
          continue;
        }
        logger.error(`[${localTimestamp()}] Meta-analyze failed for window ${w.id}:`, err);
      }
      const healthAfter = await getLlmHealth(db);
      if (isLlmPaused(healthAfter)) {
        logger.warn(`[${localTimestamp()}] Pipeline: LLM paused during meta-analysis, stopping further windows this run.`);
        break;
      }
    }

    // 4. Evaluate alerting rules ONLY for successfully analyzed windows
    for (const w of analyzedWindows) {
      try {
        await evaluateAlerts(db, w.id);
      } catch (err) {
        logger.error(`[${localTimestamp()}] Alert evaluation failed for window ${w.id}:`, err);
      }
    }

    // 5. Run discovery grouping engine (non-critical, checks enabled internally)
    try {
      await runGroupingEngine(db);
    } catch (err) {
      logger.warn(`[${localTimestamp()}] Discovery grouping engine failed:`, err);
    }

    const elapsed = Date.now() - start;
    logger.debug(
      `[${localTimestamp()}] Pipeline run complete in ${elapsed}ms. Scored=${scoringResult.scored}, Windows=${windows.length}, Analyzed=${analyzedWindows.length}`,
    );

    return { scored: scoringResult.scored, windows: windows.length, analyzed: analyzedWindows.length };
  } catch (err) {
    logger.error(`[${localTimestamp()}] Pipeline run failed:`, err);
    return { scored: 0, windows: 0, analyzed: 0 };
  }
}

/**
 * Start an adaptive pipeline scheduler.
 * After each run the interval adapts based on activity:
 *   - activity (scored > 0 || analyzed > 0) → reset to min interval
 *   - idle → double current interval, capped at max
 * Syncs AI config from DB before each run and skips if no API key.
 */
export function startPipelineScheduler(
  db: Knex,
  llm: OpenAiAdapter,
): { stop: () => void } {
  let running = false;
  let stopped = false;
  let currentTimer: ReturnType<typeof setTimeout> | null = null;
  let currentIntervalMs = 15 * 60_000; // will be overwritten on first config load

  async function tick() {
    if (stopped) return;
    if (running) {
      logger.warn(`[${localTimestamp()}] Pipeline: previous run still in progress, skipping.`);
      void scheduleNext(false);
      return;
    }
    running = true;
    try {
      await syncAdapterConfig(db, llm);

      if (!llm.isConfigured()) {
        void scheduleNext(false);
        return;
      }

      const health = await getLlmHealth(db);
      if (isLlmPaused(health)) {
        const until = health.pause_until ? Date.parse(health.pause_until) : NaN;
        const delay = Number.isFinite(until)
          ? Math.max(5_000, until - Date.now() + 1_000)
          : 60_000;
        logger.warn(
          `[${localTimestamp()}] Pipeline tick skipped: LLM provider paused` +
          `${health.reason ? ` (${health.reason})` : ''} until ${health.pause_until}. ` +
          `Retrying in ${Math.round(delay / 1000)}s.`,
        );
        void scheduleIn(delay);
        return;
      }

      const result = await runPipeline(db, llm);
      const healthAfter = await getLlmHealth(db);
      if (isLlmPaused(healthAfter)) {
        const until = healthAfter.pause_until ? Date.parse(healthAfter.pause_until) : NaN;
        const delay = Number.isFinite(until)
          ? Math.max(5_000, until - Date.now() + 1_000)
          : 60_000;
        logger.warn(
          `[${localTimestamp()}] Pipeline: LLM paused during this run; retrying in ${Math.round(delay / 1000)}s.`,
        );
        void scheduleIn(delay);
        return;
      }
      const hadActivity = result.scored > 0 || result.analyzed > 0;
      void scheduleNext(hadActivity);
    } catch (err) {
      logger.error(`[${localTimestamp()}] Pipeline tick error:`, err);
      void scheduleNext(false);
    } finally {
      running = false;
    }
  }

  function scheduleIn(ms: number) {
    if (stopped) return;
    currentTimer = setTimeout(tick, ms);
  }

  async function scheduleNext(hadActivity: boolean) {
    if (stopped) return;

    let minMs = 15 * 60_000;
    let maxMs = 120 * 60_000;
    try {
      const cfg = await loadPipelineConfig(db);
      minMs = Math.max(1, cfg.pipeline_min_interval_minutes) * 60_000;
      maxMs = Math.max(1, cfg.pipeline_max_interval_minutes) * 60_000;
    } catch { /* use defaults */ }

    if (stopped) return; // Re-check after async config load

    const prevMs = currentIntervalMs;
    if (hadActivity) {
      currentIntervalMs = minMs;
    } else {
      currentIntervalMs = Math.min(currentIntervalMs * 2, maxMs);
    }

    if (currentIntervalMs !== prevMs) {
      logger.debug(
        `[${localTimestamp()}] Pipeline scheduler: interval ${hadActivity ? 'reset' : 'backed off'} → ${Math.round(currentIntervalMs / 1000)}s`,
      );
    }

    currentTimer = setTimeout(tick, currentIntervalMs);
  }

  // Kick-off: load config to set initial interval, then schedule first tick
  (async () => {
    try {
      const cfg = await loadPipelineConfig(db);
      currentIntervalMs = cfg.pipeline_min_interval_minutes * 60_000;
    } catch { /* keep default */ }

    logger.info(
      `[${localTimestamp()}] Pipeline scheduler started (adaptive ${Math.round(currentIntervalMs / 1000)}s–` +
      `reads min/max from DB).`,
    );
    currentTimer = setTimeout(tick, currentIntervalMs);
  })();

  return {
    stop: () => {
      stopped = true;
      if (currentTimer) clearTimeout(currentTimer);
      logger.info(`[${localTimestamp()}] Pipeline scheduler stopped.`);
    },
  };
}
