import { Buffer } from 'node:buffer';
import type { ConnectorAdapter } from './interface.js';
import type { NormalizedEvent } from '../../types/index.js';
import { resolveEnvRef } from './envRef.js';
import { validateUrl } from './urlValidation.js';

interface KafkaCursor {
  offsets: Array<{ topic: string; partition: number; offset: number }>;
  updated_at?: string;
}

/**
 * Pull connector for Kafka via Confluent-compatible REST Proxy (v2 consumer API).
 *
 * Config:
 * {
 *   url: string,
 *   topic: string,
 *   consumer_group?: string,
 *   format?: 'json' | 'binary',
 *   fetch_timeout_ms?: number,
 *   max_bytes?: number,
 *   auth_header_ref?: string,
 *   username_ref?: string,
 *   password_ref?: string
 * }
 */
export class KafkaRestConnector implements ConnectorAdapter {
  readonly type = 'pull_kafka_rest';

  async fetchLogs(
    config: Record<string, unknown>,
    cursor: string | null,
  ): Promise<{ events: NormalizedEvent[]; newCursor: string | null }> {
    const url = asNonEmptyString(config.url);
    const topic = asNonEmptyString(config.topic);
    if (!url) throw new Error('Kafka REST URL not configured');
    if (!topic) throw new Error('Kafka topic is required');
    validateUrl(url);

    const baseUrl = trimTrailingSlashes(url);
    const group = sanitizeGroupName(asNonEmptyString(config.consumer_group) ?? `logpulse-${topic}`);
    const format = (asNonEmptyString(config.format) ?? 'json').toLowerCase() === 'binary' ? 'binary' : 'json';
    const fetchTimeoutMs = clampInt(config.fetch_timeout_ms, 100, 30000, 3000);
    const maxBytes = clampInt(config.max_bytes, 1024, 5_000_000, 300000);
    const cursorState = parseCursor(cursor);

    const headers = buildKafkaHeaders(config);
    const instance = `ls-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

    let baseUri: string | null = null;
    try {
      // 1) Create ephemeral consumer instance
      const createRes = await fetch(`${baseUrl}/consumers/${encodeURIComponent(group)}`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          name: instance,
          format,
          'auto.offset.reset': cursorState ? 'earliest' : 'latest',
          'enable.auto.commit': false,
        }),
        redirect: 'error',
      });
      if (!createRes.ok) {
        throw new Error(`Kafka REST create consumer failed ${createRes.status}: ${await createRes.text()}`);
      }
      const created = await createRes.json() as { base_uri?: string };
      if (!created.base_uri) {
        throw new Error('Kafka REST create consumer did not return base_uri');
      }
      baseUri = created.base_uri;
      validateUrl(baseUri);

      // 2) Subscribe to topic
      const subRes = await fetch(`${baseUri}/subscription`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ topics: [topic] }),
        redirect: 'error',
      });
      if (!subRes.ok) {
        throw new Error(`Kafka REST subscribe failed ${subRes.status}: ${await subRes.text()}`);
      }

      // 3) Seek cursor offsets (if available)
      if (cursorState && cursorState.offsets.length > 0) {
        const seekRes = await fetch(`${baseUri}/positions`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ offsets: cursorState.offsets }),
          redirect: 'error',
        });
        if (!seekRes.ok) {
          throw new Error(`Kafka REST seek failed ${seekRes.status}: ${await seekRes.text()}`);
        }
      }

      // 4) Fetch records
      const acceptType = format === 'binary'
        ? 'application/vnd.kafka.binary.v2+json'
        : 'application/vnd.kafka.json.v2+json';
      const recordsRes = await fetch(
        `${baseUri}/records?timeout=${fetchTimeoutMs}&max_bytes=${maxBytes}`,
        {
          method: 'GET',
          headers: {
            ...headers,
            Accept: acceptType,
          },
          redirect: 'error',
        },
      );
      if (!recordsRes.ok) {
        throw new Error(`Kafka REST records failed ${recordsRes.status}: ${await recordsRes.text()}`);
      }

      const records = await recordsRes.json() as Array<Record<string, unknown>>;
      const offsets = buildNextOffsets(cursorState, topic, records);
      const events = recordsToEvents(records, topic, format);

      // 5) Commit fetched offsets (best effort)
      if (offsets.length > 0) {
        try {
          await fetch(`${baseUri}/offsets`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ offsets: offsets.map((o) => ({ topic: o.topic, partition: o.partition, offset: o.offset })) }),
            redirect: 'error',
          });
        } catch {
          // Non-fatal: cursor tracking still prevents replay for this connector.
        }
      }

      const nextCursor: KafkaCursor = {
        offsets,
        updated_at: new Date().toISOString(),
      };

      return {
        events,
        newCursor: JSON.stringify(nextCursor),
      };
    } finally {
      if (baseUri) {
        try {
          await fetch(baseUri, {
            method: 'DELETE',
            headers: {
              ...headers,
              'Content-Type': 'application/vnd.kafka.v2+json',
            },
            redirect: 'error',
          });
        } catch {
          // Best-effort cleanup for ephemeral consumers.
        }
      }
    }
  }
}

function recordsToEvents(
  records: Array<Record<string, unknown>>,
  topic: string,
  format: 'json' | 'binary',
): NormalizedEvent[] {
  const out: NormalizedEvent[] = [];
  for (const rec of records) {
    const value = decodeRecordValue(rec.value, format);
    const parsed = asObject(value);

    const timestamp = normalizeTimestamp(
      asNonEmptyString((parsed as any)?.timestamp)
        ?? asNonEmptyString((parsed as any)?.time)
        ?? asNonEmptyString((parsed as any)?.['@timestamp'])
        ?? asTimestampInput(rec.timestamp),
    );

    const message = asNonEmptyString((parsed as any)?.message)
      ?? asNonEmptyString((parsed as any)?.msg)
      ?? asNonEmptyString((parsed as any)?.log)
      ?? (typeof value === 'string' ? value : JSON.stringify(value));

    const partition = Number(rec.partition);
    const offset = Number(rec.offset);
    const externalId = Number.isFinite(partition) && Number.isFinite(offset)
      ? `${topic}:${partition}:${offset}`
      : undefined;

    out.push({
      timestamp,
      message,
      severity: asNonEmptyString((parsed as any)?.severity) ?? asNonEmptyString((parsed as any)?.level),
      host: asNonEmptyString((parsed as any)?.host) ?? asNonEmptyString((parsed as any)?.hostname),
      service: asNonEmptyString((parsed as any)?.service) ?? asNonEmptyString((parsed as any)?.app),
      facility: asNonEmptyString((parsed as any)?.facility),
      program: asNonEmptyString((parsed as any)?.program),
      raw: rec,
      external_id: externalId,
    });
  }
  return out;
}

function buildNextOffsets(
  current: KafkaCursor | null,
  topic: string,
  records: Array<Record<string, unknown>>,
): Array<{ topic: string; partition: number; offset: number }> {
  const map = new Map<string, { topic: string; partition: number; offset: number }>();

  for (const off of current?.offsets ?? []) {
    map.set(`${off.topic}:${off.partition}`, { ...off });
  }

  for (const rec of records) {
    const partition = Number(rec.partition);
    const offset = Number(rec.offset);
    const recTopic = asNonEmptyString(rec.topic) ?? topic;
    if (!Number.isFinite(partition) || !Number.isFinite(offset)) continue;
    const nextOffset = Math.floor(offset) + 1;
    const key = `${recTopic}:${partition}`;
    const existing = map.get(key);
    if (!existing || nextOffset > existing.offset) {
      map.set(key, { topic: recTopic, partition, offset: nextOffset });
    }
  }

  return Array.from(map.values()).sort((a, b) => {
    if (a.topic === b.topic) return a.partition - b.partition;
    return a.topic.localeCompare(b.topic);
  });
}

function parseCursor(cursor: string | null): KafkaCursor | null {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(cursor) as KafkaCursor;
    if (!parsed || !Array.isArray(parsed.offsets)) return null;
    const offsets = parsed.offsets
      .filter((o) => o && typeof o.topic === 'string' && Number.isFinite(o.partition) && Number.isFinite(o.offset))
      .map((o) => ({
        topic: o.topic,
        partition: Math.floor(Number(o.partition)),
        offset: Math.floor(Number(o.offset)),
      }));
    return { offsets };
  } catch {
    return null;
  }
}

function decodeRecordValue(value: unknown, format: 'json' | 'binary'): unknown {
  if (format === 'binary' && typeof value === 'string') {
    try {
      const decoded = Buffer.from(value, 'base64').toString('utf8');
      const parsed = JSON.parse(decoded);
      return parsed;
    } catch {
      return value;
    }
  }
  return value;
}

function asObject(v: unknown): Record<string, unknown> | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  return v as Record<string, unknown>;
}

function buildKafkaHeaders(config: Record<string, unknown>): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/vnd.kafka.v2+json',
    Accept: 'application/vnd.kafka.v2+json',
  };

  const authRef = asNonEmptyString(config.auth_header_ref);
  if (authRef) {
    const auth = resolveEnvRef(authRef);
    if (auth) {
      headers.Authorization = auth;
      return headers;
    }
  }

  const userRef = asNonEmptyString(config.username_ref);
  const passRef = asNonEmptyString(config.password_ref);
  if (userRef && passRef) {
    const username = resolveEnvRef(userRef);
    const password = resolveEnvRef(passRef);
    if (username && password) {
      const encoded = Buffer.from(`${username}:${password}`, 'utf8').toString('base64');
      headers.Authorization = `Basic ${encoded}`;
    }
  }

  return headers;
}

function sanitizeGroupName(group: string): string {
  const cleaned = group.replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 120);
  return cleaned.length > 0 ? cleaned : 'logpulse-default';
}

function asNonEmptyString(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined;
}

function asTimestampInput(v: unknown): string | undefined {
  if (typeof v === 'string' && v.trim().length > 0) return v.trim();
  if (typeof v === 'number' && Number.isFinite(v)) return new Date(v).toISOString();
  return undefined;
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.floor(n), min), max);
}

function trimTrailingSlashes(v: string): string {
  return v.replace(/\/+$/, '');
}

function normalizeTimestamp(input: string | null | undefined): string {
  if (!input) return new Date().toISOString();
  const d = new Date(input);
  return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}
