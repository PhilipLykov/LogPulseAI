import type { Knex } from 'knex';

/**
 * Migration 033 — MITRE ATT&CK + confidence support.
 *
 * Adds:
 * - meta_results.analysis_confidence (0..1, nullable)
 * - findings.confidence (0..1, nullable)
 * - findings.mitre_techniques (JSONB string array, nullable)
 */
export async function up(knex: Knex): Promise<void> {
  const hasMetaConfidence = await knex.schema.hasColumn('meta_results', 'analysis_confidence');
  if (!hasMetaConfidence) {
    await knex.schema.alterTable('meta_results', (t) => {
      t.float('analysis_confidence').nullable();
    });
  }

  const hasFindingConfidence = await knex.schema.hasColumn('findings', 'confidence');
  const hasMitreTechniques = await knex.schema.hasColumn('findings', 'mitre_techniques');
  if (!hasFindingConfidence || !hasMitreTechniques) {
    await knex.schema.alterTable('findings', (t) => {
      if (!hasFindingConfidence) t.float('confidence').nullable();
      if (!hasMitreTechniques) t.jsonb('mitre_techniques').nullable().defaultTo(null);
    });
  }
}

export async function down(knex: Knex): Promise<void> {
  const hasMetaConfidence = await knex.schema.hasColumn('meta_results', 'analysis_confidence');
  if (hasMetaConfidence) {
    await knex.schema.alterTable('meta_results', (t) => {
      t.dropColumn('analysis_confidence');
    });
  }

  const hasFindingConfidence = await knex.schema.hasColumn('findings', 'confidence');
  const hasMitreTechniques = await knex.schema.hasColumn('findings', 'mitre_techniques');
  if (hasFindingConfidence || hasMitreTechniques) {
    await knex.schema.alterTable('findings', (t) => {
      if (hasFindingConfidence) t.dropColumn('confidence');
      if (hasMitreTechniques) t.dropColumn('mitre_techniques');
    });
  }
}
