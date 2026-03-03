import type { ConnectorAdapter } from './interface.js';
import type { NormalizedEvent } from '../../types/index.js';
import { resolveEnvRef } from './envRef.js';
import { validateUrl } from './urlValidation.js';

/**
 * Pull connector for VictoriaLogs.
 *
 * Uses LogsQL HTTP API:
 *   POST /select/logsql/query
 * with x-www-form-urlencoded body containing query/start/end/limit.
 *
 * Response is NDJSON (one JSON log object per line).
 *
 * Config:
 * {
 *   url: string,
 *   query?: string,
 *   limit?: number,
 *   auth_header_ref?: string
 * }
 */
export class VictoriaLogsConnector implements ConnectorAdapter {
  readonly type = 'pull_victorialogs';

  async fetchLogs(
    config: Record<string, unknown>,
    cursor: string | null,
  ): Promise<{ events: NormalizedEvent[]; newCursor: string | null }> {
    const url = asNonEmptyString(config.url);
    if (!url) throw new Error('VictoriaLogs URL not configured');
    validateUrl(url);

    const query = asNonEmptyString(config.query) ?? '*';
    const limit = clampInt(config.limit, 1, 5000, 1000);
    const authRef = asNonEmptyString(config.auth_header_ref);

    const fromIso = isValidIso(cursor)
      ? cursor!
      : new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const toIso = new Date().toISOString();

    const params = new URLSearchParams({
      query,
      start: fromIso,
      end: toIso,
      limit: String(limit),
    });

    const headers: Record<string, string> = {
      'Content-Type': 'application/x-www-form-urlencoded',
    };
    if (authRef) {
      const auth = resolveEnvRef(authRef);
      if (auth) headers.Authorization = auth;
    }

    const endpoint = `${trimTrailingSlashes(url)}/select/logsql/query`;
    const res = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: params.toString(),
      redirect: 'error',
    });

    if (!res.ok) {
      throw new Error(`VictoriaLogs ${res.status}: ${await res.text()}`);
    }

    const text = await res.text();
    const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);

    const events: NormalizedEvent[] = [];
    let newestTs = fromIso;

    for (const line of lines) {
      let row: Record<string, unknown>;
      try {
        row = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }

      const timestamp = normalizeTimestamp(
        asNonEmptyString(row._time)
          ?? asNonEmptyString(row.timestamp)
          ?? asNonEmptyString(row.time),
      );
      if (timestamp > newestTs) newestTs = timestamp;

      const message = asNonEmptyString(row._msg)
        ?? asNonEmptyString(row.message)
        ?? asNonEmptyString(row.msg)
        ?? JSON.stringify(row);

      events.push({
        timestamp,
        message,
        severity: asNonEmptyString(row.level) ?? asNonEmptyString(row.severity),
        host: asNonEmptyString(row.host) ?? asNonEmptyString(row.hostname),
        service: asNonEmptyString(row.service) ?? asNonEmptyString(row.app),
        facility: asNonEmptyString(row.facility),
        program: asNonEmptyString(row.program),
        raw: row,
      });
    }

    return {
      events,
      newCursor: events.length > 0 && newestTs > fromIso ? newestTs : toIso,
    };
  }
}

function asNonEmptyString(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined;
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.floor(n), min), max);
}

function trimTrailingSlashes(v: string): string {
  return v.replace(/\/+$/, '');
}

function isValidIso(v: string | null | undefined): boolean {
  return !!v && !Number.isNaN(Date.parse(v));
}

function normalizeTimestamp(input: string | undefined): string {
  if (!input) return new Date().toISOString();
  const d = new Date(input);
  return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}
