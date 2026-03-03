import type { Knex } from 'knex';

/**
 * Migration 032 — Hot path indexes for dashboard/search workloads.
 *
 * Targets:
 *  - SSE polling query over meta_results.created_at
 *  - Event search severity filter using LOWER(events.severity)
 *  - Acknowledged-event lookups used by ack-transition background jobs
 *  - Dashboard DISTINCT ON score selection over effective_scores
 */
export async function up(knex: Knex): Promise<void> {
  // SSE poll path: recent meta-results by created_at.
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_meta_results_created_at
    ON meta_results (created_at DESC)
  `);

  // Event search uses LOWER(events.severity) in WHERE; add matching functional index.
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_events_lower_severity
    ON events ((LOWER(severity)))
    WHERE severity IS NOT NULL
  `);

  // Background finding-transition queries frequently scan acknowledged events
  // by time (and optionally by system_id).
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_events_ackd_ts
    ON events ("timestamp" DESC)
    WHERE acknowledged_at IS NOT NULL
  `);

  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_events_system_ackd_ts
    ON events (system_id, "timestamp" DESC)
    WHERE acknowledged_at IS NOT NULL
  `);

  // Dashboard systems endpoint picks max effective score per (system, criterion).
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_effective_scores_sys_crit_effective
    ON effective_scores (system_id, criterion_id, effective_value DESC, window_id)
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`DROP INDEX IF EXISTS idx_effective_scores_sys_crit_effective`);
  await knex.raw(`DROP INDEX IF EXISTS idx_events_system_ackd_ts`);
  await knex.raw(`DROP INDEX IF EXISTS idx_events_ackd_ts`);
  await knex.raw(`DROP INDEX IF EXISTS idx_events_lower_severity`);
  await knex.raw(`DROP INDEX IF EXISTS idx_meta_results_created_at`);
}
