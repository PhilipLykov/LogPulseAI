/**
 * Knex CLI config — standalone configuration for running Knex CLI commands.
 * Usage: npx tsx node_modules/.bin/knex migrate:latest --knexfile knexfile.ts
 *
 * NOTE: This file is for CLI use only. The runtime app uses src/db/knexConfig.ts.
 * WARNING: If you change DB defaults here, also update src/config/index.ts to match.
 */
import 'dotenv/config';
import type { Knex } from 'knex';

const config: Knex.Config = {
  client: 'pg',
  connection: {
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT || 5432),
    database: process.env.DB_NAME || 'logpulse_ai',
    user: process.env.DB_USER || 'syslog_ai',
    password: process.env.DB_PASSWORD ?? '',
  },
  pool: { min: 2, max: 10 },
  migrations: {
    directory: './src/db/migrations',
    extension: 'ts',
  },
  seeds: {
    directory: './src/db/seeds',
    extension: 'ts',
  },
};

export default config;
