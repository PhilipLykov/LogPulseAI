import { Buffer } from 'node:buffer';
import type { ConnectorAdapter } from './interface.js';
import type { NormalizedEvent } from '../../types/index.js';
import { resolveEnvRef } from './envRef.js';
import { validateUrl } from './urlValidation.js';

/**
 * Pull connector for RabbitMQ Management HTTP API.
 *
 * Uses:
 *   POST /api/queues/{vhost}/{queue}/get
 *
 * Config:
 * {
 *   url: string,
 *   queue: string,
 *   vhost?: string,
 *   batch_size?: number,
 *   auth_header_ref?: string,
 *   username_ref?: string,
 *   password_ref?: string
 * }
 */
export class RabbitMqConnector implements ConnectorAdapter {
  readonly type = 'pull_rabbitmq';

  async fetchLogs(
    config: Record<string, unknown>,
    _cursor: string | null,
  ): Promise<{ events: NormalizedEvent[]; newCursor: string | null }> {
    const url = asNonEmptyString(config.url);
    const queue = asNonEmptyString(config.queue);
    if (!url) throw new Error('RabbitMQ URL not configured');
    if (!queue) throw new Error('RabbitMQ queue is required');
    validateUrl(url);

    const vhost = asNonEmptyString(config.vhost) ?? '/';
    const batchSize = clampInt(config.batch_size, 1, 500, 100);

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    applyAuthHeaders(headers, config);

    const endpoint = `${trimTrailingSlashes(url)}/api/queues/${encodeURIComponent(vhost)}/${encodeURIComponent(queue)}/get`;
    const res = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        count: batchSize,
        ackmode: 'ack_requeue_false',
        encoding: 'auto',
        truncate: 262144,
      }),
      redirect: 'error',
    });

    if (!res.ok) {
      throw new Error(`RabbitMQ ${res.status}: ${await res.text()}`);
    }

    const body = await res.json();
    const nowIso = new Date().toISOString();
    if (!Array.isArray(body)) {
      return { events: [], newCursor: nowIso };
    }
    const rows = body as Array<Record<string, unknown>>;
    const events: NormalizedEvent[] = [];

    for (const row of rows) {
      const payload = decodePayload(row);
      const parsed = tryParseJson(payload);

      const timestamp = normalizeTimestamp(
        asNonEmptyString((parsed as any)?.timestamp)
          ?? asNonEmptyString((parsed as any)?.time)
          ?? asNonEmptyString((parsed as any)?.['@timestamp'])
          ?? parseRabbitTimestamp((row.properties as any)?.timestamp),
      );

      const message = asNonEmptyString((parsed as any)?.message)
        ?? asNonEmptyString((parsed as any)?.msg)
        ?? asNonEmptyString((parsed as any)?.log)
        ?? payload
        ?? '(empty payload)';

      const messageId = asNonEmptyString((row.properties as any)?.message_id);
      const deliveryTag = Number((row as any).delivery_tag);
      const externalId = messageId ?? (Number.isFinite(deliveryTag) ? `${queue}:${deliveryTag}` : undefined);

      events.push({
        timestamp,
        message,
        severity: asNonEmptyString((parsed as any)?.severity) ?? asNonEmptyString((parsed as any)?.level),
        host: asNonEmptyString((parsed as any)?.host) ?? asNonEmptyString((parsed as any)?.hostname),
        service: asNonEmptyString((parsed as any)?.service) ?? asNonEmptyString((parsed as any)?.app),
        facility: asNonEmptyString((parsed as any)?.facility),
        program: asNonEmptyString((parsed as any)?.program),
        raw: {
          ...row,
          decoded_payload: payload,
        },
        external_id: externalId,
      });
    }

    return {
      events,
      newCursor: nowIso,
    };
  }
}

function applyAuthHeaders(headers: Record<string, string>, config: Record<string, unknown>): void {
  const authRef = asNonEmptyString(config.auth_header_ref);
  if (authRef) {
    const auth = resolveEnvRef(authRef);
    if (auth) {
      headers.Authorization = auth;
      return;
    }
  }

  const userRef = asNonEmptyString(config.username_ref);
  const passRef = asNonEmptyString(config.password_ref);
  if (!userRef || !passRef) return;

  const username = resolveEnvRef(userRef);
  const password = resolveEnvRef(passRef);
  if (!username || !password) return;

  const encoded = Buffer.from(`${username}:${password}`, 'utf8').toString('base64');
  headers.Authorization = `Basic ${encoded}`;
}

function decodePayload(row: Record<string, unknown>): string {
  const payload = row.payload;
  const encoding = asNonEmptyString(row.payload_encoding) ?? 'string';
  if (typeof payload !== 'string') {
    return typeof payload === 'undefined' ? '' : JSON.stringify(payload);
  }
  if (encoding === 'base64') {
    try {
      return Buffer.from(payload, 'base64').toString('utf8');
    } catch {
      return payload;
    }
  }
  return payload;
}

function tryParseJson(v: string): Record<string, unknown> | null {
  if (!v) return null;
  try {
    const parsed = JSON.parse(v);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function parseRabbitTimestamp(v: unknown): string | null {
  if (typeof v === 'number' && Number.isFinite(v)) {
    return new Date(v * 1000).toISOString();
  }
  if (typeof v === 'string' && v.trim().length > 0) {
    const numeric = Number(v);
    if (Number.isFinite(numeric)) return new Date(numeric * 1000).toISOString();
    return v;
  }
  return null;
}

function normalizeTimestamp(input: string | null | undefined): string {
  if (!input) return new Date().toISOString();
  const d = new Date(input);
  return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
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
