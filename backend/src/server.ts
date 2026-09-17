import { config, localTimestamp } from './config/index.js';
import { initDb, closeDb } from './db/index.js';
import { ensureAdminKey } from './middleware/apiKeys.js';
import { ensureAdminUser } from './middleware/bootstrapAdmin.js';
import { getDb } from './db/index.js';
import { buildApp } from './app.js';
import { OpenAiAdapter } from './modules/llm/adapter.js';
import { startPipelineScheduler } from './modules/pipeline/orchestrator.js';
import { runQuotaPoisonRecovery } from './modules/llm/llmCircuit.js';
import { startConnectorScheduler } from './modules/connectors/runner.js';
import { startMaintenanceScheduler } from './modules/maintenance/maintenanceJob.js';
import { startScheduledReportScheduler } from './modules/alerting/scheduledReports.js';
import { closeAllEsClients } from './services/esClient.js';

/**
 * Parse a millisecond interval from an env var, with safe default.
 * Returns fallback if env is empty, non-numeric, or negative.
 */
function envIntervalMs(value: string | undefined, fallback: number): number {
  if (!value || value.trim() === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

async function main(): Promise<void> {
  console.log(`[${localTimestamp()}] Starting LogPulse AI backend…`);

  // 1. Initialize database (run migrations + seeds)
  await initDb();
  const db = getDb();

  // 2. Ensure at least one admin API key exists + bootstrap admin user
  await ensureAdminKey(db, config.adminApiKey || undefined);
  await ensureAdminUser(db);

  // 3. Bind HTTP before score repair. 0.9.5 ran a single multi-million-row
  //    UPDATE first, so port 3000 never opened and the dashboard showed
  //    "Network error".
  const app = await buildApp();

  try {
    await app.listen({ host: config.host, port: config.port });
    console.log(`[${localTimestamp()}] Server listening on http://${config.host}:${config.port}`);
  } catch (err) {
    console.error(`[${localTimestamp()}] Failed to start server:`, err);
    process.exit(1);
  }

  // 4. Reopen poisoned zero scores (batched). Pipeline waits so it does not
  //    write new "all routine" windows on top of the old ones.
  await runQuotaPoisonRecovery(db);

  // 5. Start pipeline scheduler — always starts, checks AI config dynamically
  //    (API key may come from env or DB, and can be set/changed via UI at runtime)
  const llm = new OpenAiAdapter();
  const pipelineScheduler = startPipelineScheduler(db, llm);

  // 6. Start connector poll scheduler
  const connectorIntervalMs = envIntervalMs(process.env.CONNECTOR_POLL_INTERVAL_MS, 60_000);
  const connectorScheduler = startConnectorScheduler(db, connectorIntervalMs);

  // 7. Start database maintenance scheduler (retention cleanup, VACUUM, REINDEX)
  //    Default check interval: 30 minutes (actual run frequency governed by maintenance_interval_hours config)
  const maintenanceCheckMs = envIntervalMs(process.env.MAINTENANCE_CHECK_INTERVAL_MS, 30 * 60 * 1000);
  const maintenanceScheduler = startMaintenanceScheduler(db, maintenanceCheckMs);

  // 8. Start scheduled-report scheduler
  const scheduledReportsIntervalMs = envIntervalMs(process.env.SCHEDULED_REPORT_CHECK_INTERVAL_MS, 60_000);
  const scheduledReportScheduler = startScheduledReportScheduler(db, scheduledReportsIntervalMs);

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    console.log(`[${localTimestamp()}] Received ${signal}, shutting down…`);
    scheduledReportScheduler.stop();
    maintenanceScheduler.stop();
    connectorScheduler.stop();
    pipelineScheduler?.stop();
    try {
      await closeAllEsClients();
      await app.close();
      await closeDb();
    } catch (err) {
      console.error(`[${localTimestamp()}] Error during shutdown:`, err);
    }
    process.exit(0);
  };

  process.on('SIGINT', () => { shutdown('SIGINT').catch(() => process.exit(1)); });
  process.on('SIGTERM', () => { shutdown('SIGTERM').catch(() => process.exit(1)); });
}

main().catch((err) => {
  console.error(`[${localTimestamp()}] Fatal error:`, err);
  process.exit(1);
});
