import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  const hasColumn = await knex.schema.hasColumn('log_sources', 'parse_profile');
  if (!hasColumn) {
    await knex.schema.alterTable('log_sources', (t) => {
      t.string('parse_profile', 64).nullable().defaultTo(null);
    });
    console.log('[Migration 034] Added parse_profile column to log_sources');
  }
}

export async function down(knex: Knex): Promise<void> {
  const hasColumn = await knex.schema.hasColumn('log_sources', 'parse_profile');
  if (hasColumn) {
    await knex.schema.alterTable('log_sources', (t) => {
      t.dropColumn('parse_profile');
    });
  }
}
