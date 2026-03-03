import { v4 as uuidv4 } from 'uuid';
import type { Knex } from 'knex';
import { logger } from '../../config/logger.js';
import { localTimestamp } from '../../config/index.js';
import { generateComplianceExport } from '../features/exportCompliance.js';
import { sendNotification, type AlertPayload } from './channels.js';

type ReportType = 'json' | 'csv' | 'summary';

interface ScheduledReportRow {
  id: string;
  name: string;
  channel_id: string | null;
  schedule: string;
  report_type: ReportType;
  filters: any;
  last_run_at: string | null;
  next_run_at: string | null;
  enabled: boolean;
}

interface ParsedFilters {
  system_ids?: string[];
  lookback_hours: number;
}

const DEFAULT_LOOKBACK_HOURS = 24;
const MIN_LOOKBACK_HOURS = 1;
const MAX_LOOKBACK_HOURS = 24 * 30;

/**
 * Validate schedule syntax for a practical, safe subset of cron:
 * - every N minutes: star-slash-5 format
 * - hourly:          0 * * * *
 * - daily:           0 0 * * *
 * - weekly:          0 0 * * 0..6
 */
export function isSupportedSchedule(schedule: string): boolean {
  const s = schedule.trim();
  if (/^\*\/([1-9]\d{0,3}) \* \* \* \*$/.test(s)) return true;
  if (s === '0 * * * *') return true;
  if (s === '0 0 * * *') return true;
  if (/^0 0 \* \* [0-6]$/.test(s)) return true;
  return false;
}

export function computeNextRunAt(schedule: string, from: Date = new Date()): Date {
  const s = schedule.trim();
  const nowMs = from.getTime();

  const everyMin = s.match(/^\*\/([1-9]\d{0,3}) \* \* \* \*$/);
  if (everyMin) {
    const n = Number(everyMin[1]);
    const stepMs = n * 60_000;
    const next = Math.floor(nowMs / stepMs) * stepMs + stepMs;
    return new Date(next);
  }

  // 0 * * * *  (top of next hour, UTC)
  if (s === '0 * * * *') {
    const d = new Date(nowMs);
    d.setUTCMinutes(0, 0, 0);
    d.setUTCHours(d.getUTCHours() + 1);
    return d;
  }

  // 0 0 * * *  (next UTC day midnight)
  if (s === '0 0 * * *') {
    const d = new Date(nowMs);
    d.setUTCHours(0, 0, 0, 0);
    d.setUTCDate(d.getUTCDate() + 1);
    return d;
  }

  // 0 0 * * X  (next UTC weekday midnight)
  const weekly = s.match(/^0 0 \* \* ([0-6])$/);
  if (weekly) {
    const targetDay = Number(weekly[1]); // 0=Sunday
    const d = new Date(nowMs);
    d.setUTCHours(0, 0, 0, 0);
    // Ensure "next", not "current if same day+time already passed".
    d.setUTCDate(d.getUTCDate() + 1);
    while (d.getUTCDay() !== targetDay) {
      d.setUTCDate(d.getUTCDate() + 1);
    }
    return d;
  }

  // Defensive fallback for unvalidated callers.
  const fallback = new Date(nowMs + 60_000);
  return fallback;
}

function parseFilters(raw: unknown): ParsedFilters {
  let f: any = raw;
  if (typeof f === 'string') {
    try { f = JSON.parse(f); } catch { f = {}; }
  }
  if (!f || typeof f !== 'object' || Array.isArray(f)) f = {};

  const lookbackRaw = Number(f.lookback_hours);
  const lookback = Number.isFinite(lookbackRaw)
    ? Math.min(Math.max(Math.floor(lookbackRaw), MIN_LOOKBACK_HOURS), MAX_LOOKBACK_HOURS)
    : DEFAULT_LOOKBACK_HOURS;

  const systemIds = Array.isArray(f.system_ids)
    ? f.system_ids.filter((x: unknown) => typeof x === 'string' && x.length > 0).slice(0, 200)
    : undefined;

  return {
    lookback_hours: lookback,
    system_ids: systemIds && systemIds.length > 0 ? systemIds : undefined,
  };
}

function buildReportPayload(
  reportName: string,
  reportType: ReportType,
  reportData: string,
  fromIso: string,
  toIso: string,
): AlertPayload {
  const type = reportType === 'summary' ? 'json' : reportType;
  const header = `Scheduled report "${reportName}" (${type.toUpperCase()})\nRange: ${fromIso} -> ${toIso}\n`;
  const maxLen = 3500;
  const bodyRaw = `${header}\n${reportData}`;
  const body = bodyRaw.length > maxLen
    ? `${bodyRaw.slice(0, maxLen)}\n\n...truncated...`
    : bodyRaw;

  return {
    title: `Scheduled Report: ${reportName}`,
    body,
    severity: 'info',
    variant: 'firing',
    system_name: 'LogSentinel AI',
    criterion: 'Compliance / Audit',
  };
}

async function runReportRow(db: Knex, row: ScheduledReportRow): Promise<void> {
  const now = new Date();
  const nowIso = now.toISOString();
  const filters = parseFilters(row.filters);
  const reportType: 'json' | 'csv' = row.report_type === 'csv' ? 'csv' : 'json';
  const fromIso = new Date(now.getTime() - filters.lookback_hours * 60 * 60 * 1000).toISOString();
  const toIso = nowIso;

  const { data } = await generateComplianceExport(db, {
    type: reportType,
    system_ids: filters.system_ids,
    from: fromIso,
    to: toIso,
  });

  if (row.channel_id) {
    const channel = await db('notification_channels').where({ id: row.channel_id, enabled: true }).first();
    if (channel) {
      let channelConfig = channel.config;
      if (typeof channelConfig === 'string') {
        try { channelConfig = JSON.parse(channelConfig); } catch { channelConfig = {}; }
      }
      const payload = buildReportPayload(row.name, row.report_type, data, fromIso, toIso);
      await sendNotification(channel.type, { type: channel.type, ...(channelConfig as object) }, payload);
    } else {
      logger.warn(
        `[${localTimestamp()}] Scheduled report "${row.name}" (${row.id}) has missing/disabled channel; report generated but not sent.`,
      );
    }
  }

  const nextRun = computeNextRunAt(row.schedule, now).toISOString();

  await db('scheduled_reports')
    .where({ id: row.id })
    .update({
      last_run_at: nowIso,
      next_run_at: nextRun,
    });

  // Lightweight run history entry in export_jobs.
  await db('export_jobs').insert({
    id: uuidv4(),
    type: reportType,
    params: JSON.stringify({
      source: 'scheduled_report',
      report_id: row.id,
      report_name: row.name,
      lookback_hours: filters.lookback_hours,
      system_ids: filters.system_ids ?? null,
      from: fromIso,
      to: toIso,
    }),
    status: 'done',
    file_path: null,
    error_message: null,
    created_at: nowIso,
    completed_at: nowIso,
  });
}

export async function runScheduledReportNow(db: Knex, reportId: string): Promise<void> {
  const row = await db('scheduled_reports').where({ id: reportId }).first() as ScheduledReportRow | undefined;
  if (!row) throw new Error('Scheduled report not found.');
  await runReportRow(db, row);
}

export async function runDueScheduledReports(db: Knex): Promise<number> {
  const nowIso = new Date().toISOString();

  // Ensure enabled rows with null next_run_at are initialized.
  const uninitialized = await db('scheduled_reports')
    .where({ enabled: true })
    .whereNull('next_run_at')
    .select('id', 'schedule');
  for (const row of uninitialized) {
    const next = computeNextRunAt(String(row.schedule), new Date()).toISOString();
    await db('scheduled_reports').where({ id: row.id }).update({ next_run_at: next });
  }

  const dueRows = await db('scheduled_reports')
    .where({ enabled: true })
    .whereNotNull('next_run_at')
    .andWhere('next_run_at', '<=', nowIso)
    .orderBy('next_run_at', 'asc')
    .limit(50) as ScheduledReportRow[];

  let executed = 0;
  for (const row of dueRows) {
    try {
      await runReportRow(db, row);
      executed++;
      logger.info(`[${localTimestamp()}] Scheduled report executed: ${row.name} (${row.id})`);
    } catch (err: any) {
      logger.error(
        `[${localTimestamp()}] Scheduled report failed: ${row.name} (${row.id}): ${err?.message ?? String(err)}`,
      );
      // Push next run forward even on error to avoid tight failure loops.
      try {
        const next = computeNextRunAt(row.schedule, new Date()).toISOString();
        await db('scheduled_reports').where({ id: row.id }).update({ next_run_at: next });
      } catch { /* ignore */ }
      // Persist failure snapshot (best-effort; DB may be unavailable).
      try {
        await db('export_jobs').insert({
          id: uuidv4(),
          type: row.report_type === 'csv' ? 'csv' : 'json',
          params: JSON.stringify({
            source: 'scheduled_report',
            report_id: row.id,
            report_name: row.name,
          }),
          status: 'error',
          file_path: null,
          error_message: err?.message ?? String(err),
          created_at: nowIso,
          completed_at: new Date().toISOString(),
        });
      } catch {
        // DB write for error history failed; already logged above.
      }
    }
  }

  return executed;
}

export function startScheduledReportScheduler(
  db: Knex,
  intervalMs: number = 60_000,
): { stop: () => void } {
  let running = false;

  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      const count = await runDueScheduledReports(db);
      if (count > 0) {
        logger.info(`[${localTimestamp()}] Scheduled reports: executed ${count} job(s).`);
      }
    } catch (err: any) {
      logger.error(
        `[${localTimestamp()}] Scheduled report scheduler tick failed: ${err?.message ?? String(err)}`,
      );
    } finally {
      running = false;
    }
  }, intervalMs);

  logger.info(`[${localTimestamp()}] Scheduled report scheduler started (interval=${intervalMs}ms).`);

  return {
    stop: () => {
      clearInterval(timer);
      logger.info(`[${localTimestamp()}] Scheduled report scheduler stopped.`);
    },
  };
}
