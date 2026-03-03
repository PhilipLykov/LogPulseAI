import type { Knex } from 'knex';
import type { NormalizedEvent, LogSource, LogSourceSelector } from '../../types/index.js';
import { localTimestamp } from '../../config/index.js';
import { logger } from '../../config/logger.js';
import { getParseProfile } from './parseProfiles.js';
import type { MultilineSourceHint } from './multiline.js';

/**
 * Cached log sources, sorted by priority (ascending = evaluated first).
 * Reloaded when the cache is invalidated (e.g. after source create/update/delete).
 *
 * Uses a generation counter to prevent a stale in-flight load from overwriting
 * a newer cache after invalidation.
 */
let _cachedSources: LogSource[] | null = null;
let _loadPromise: Promise<LogSource[]> | null = null;
let _generation = 0;

export function invalidateSourceCache(): void {
  _cachedSources = null;
  _loadPromise = null;
  _generation++;
}

async function loadSources(db: Knex): Promise<LogSource[]> {
  if (_cachedSources) return _cachedSources;

  // Prevent thundering herd: reuse in-flight promise
  if (_loadPromise) return _loadPromise;

  const gen = _generation;

  const promise = (async () => {
    const rows = await db('log_sources').orderBy('priority', 'asc').select('*');
    const sources = rows.map((r: any) => {
      let selector: LogSourceSelector | LogSourceSelector[] = {};
      try {
        selector = typeof r.selector === 'string' ? JSON.parse(r.selector) : (r.selector ?? {});
      } catch {
        logger.error(`[${localTimestamp()}] Invalid JSON selector for log_source ${r.id}, skipping.`);
      }
      if (!selector || (typeof selector !== 'object' && !Array.isArray(selector))) {
        selector = {};
      }
      return { ...r, selector };
    });

    // Only write to cache if generation hasn't changed during our load.
    // If invalidateSourceCache() was called while we were loading, our data
    // is potentially stale — discard it and let the next caller retry.
    if (_generation === gen) {
      _cachedSources = sources;
    }

    return sources;
  })().finally(() => {
    // Only clear if this is still the current in-flight promise
    if (_loadPromise === promise) {
      _loadPromise = null;
    }
  });

  _loadPromise = promise;
  return _loadPromise;
}

export interface SourceMatch {
  system_id: string;
  log_source_id: string;
  isCatchAll: boolean;
  parse_profile: string | null;
}

/**
 * Match a normalized event to a log source by evaluating selectors
 * in priority order. Returns { system_id, log_source_id, isCatchAll } or null.
 *
 * `isCatchAll` is true when every pattern in the matched selector is a
 * universal wildcard (e.g., `.*`). This lets the ingest route buffer
 * catch-all-only matches for auto-discovery while still ingesting them.
 *
 * Selector matching: each key in the selector must match the corresponding
 * field on the event (case-insensitive substring or exact). An empty selector
 * matches nothing.
 */
export async function matchSource(
  db: Knex,
  event: NormalizedEvent,
): Promise<SourceMatch | null> {
  const sources = await loadSources(db);

  for (const source of sources) {
    if (matchesSelector(event, source.selector)) {
      return {
        system_id: source.system_id,
        log_source_id: source.id,
        isCatchAll: isCatchAllSelector(source.selector),
        parse_profile: source.parse_profile ?? null,
      };
    }
  }

  return null;
}

/**
 * Source hints used by multiline pre-processing.
 * Only sources with a valid parse profile are returned.
 */
export async function getSourceHints(db: Knex): Promise<MultilineSourceHint[]> {
  const sources = await loadSources(db);
  const hints: MultilineSourceHint[] = [];

  for (const source of sources) {
    if (!source.parse_profile || typeof source.parse_profile !== 'string') continue;
    const profile = getParseProfile(source.parse_profile);
    if (!profile) continue;

    const hint: MultilineSourceHint = {
      source_id: source.id,
      selector: source.selector,
      parse_profile: source.parse_profile,
      multiline_mode: profile.multiline.mode,
    };

    if (profile.multiline.mode === 'timestamp_head' && profile.multiline.startPattern) {
      try {
        hint.multiline_start_re = new RegExp(profile.multiline.startPattern);
      } catch {
        // Static profile validation guard: ignore invalid start regex.
        continue;
      }
    }

    hints.push(hint);
  }

  return hints;
}

const WILDCARD_PATTERNS = new Set(['.*', '^.*$', '.+', '^.+$']);

function isCatchAllSelector(selector: LogSourceSelector | LogSourceSelector[]): boolean {
  const groups = Array.isArray(selector) ? selector : [selector];
  return groups.every(group => {
    if (!group || typeof group !== 'object') return true;
    const entries = Object.entries(group).filter(([, v]) => v !== undefined && v !== '');
    if (entries.length === 0) return true;
    return entries.every(([, pattern]) => WILDCARD_PATTERNS.has(String(pattern)));
  });
}

function matchesSelector(event: NormalizedEvent, selector: LogSourceSelector | LogSourceSelector[]): boolean {
  if (Array.isArray(selector)) {
    if (selector.length === 0) return false;
    return selector.some(group => matchesSingleGroup(event, group));
  }
  return matchesSingleGroup(event, selector);
}

function matchesSingleGroup(event: NormalizedEvent, group: LogSourceSelector): boolean {
  if (!group || typeof group !== 'object') return false;

  const entries = Object.entries(group).filter(([, v]) => v !== undefined && v !== '');
  if (entries.length === 0) return false;

  for (const [key, pattern] of entries) {
    let eventValue: unknown = (event as any)[key];

    if (eventValue === undefined && event.raw) {
      eventValue = event.raw[key];
    }

    if (eventValue === undefined || eventValue === null) {
      const pat = String(pattern);
      if (pat === '.*' || pat === '^.*$' || pat === '.+' || pat === '^.+$') continue;
      return false;
    }

    const ev = String(eventValue);

    try {
      const regex = new RegExp(String(pattern), 'i');
      if (!regex.test(ev)) return false;
    } catch {
      if (ev.toLowerCase() !== String(pattern).toLowerCase()) return false;
    }
  }

  return true;
}
