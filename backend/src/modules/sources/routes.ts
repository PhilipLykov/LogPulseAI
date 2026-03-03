import type { FastifyInstance } from 'fastify';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../../db/index.js';
import { requireAuth } from '../../middleware/auth.js';
import { PERMISSIONS } from '../../middleware/permissions.js';
import { localTimestamp } from '../../config/index.js';
import { invalidateSourceCache } from '../ingest/sourceMatch.js';
import type { CreateLogSourceBody, UpdateLogSourceBody } from '../../types/index.js';
import { writeAuditLog, getActorName } from '../../middleware/audit.js';
import { getParseProfile, listParseProfileSummaries } from '../ingest/parseProfiles.js';

const MAX_SELECTOR_GROUPS = 10;
const MAX_SELECTOR_RULES_PER_GROUP = 20;
const MAX_SELECTOR_PATTERN_LEN = 512;

function validateAndNormalizeSelector(
  selectorInput: unknown,
): { ok: true; selector: Record<string, string> | Record<string, string>[] } | { ok: false; error: string } {
  const fromArray = Array.isArray(selectorInput);
  const groups = fromArray ? selectorInput : [selectorInput];

  if (groups.length === 0) {
    return { ok: false, error: '"selector" must include at least one group.' };
  }
  if (groups.length > MAX_SELECTOR_GROUPS) {
    return { ok: false, error: `"selector" has too many groups (max ${MAX_SELECTOR_GROUPS}).` };
  }

  const normalizedGroups: Record<string, string>[] = [];
  for (const group of groups) {
    if (!group || typeof group !== 'object' || Array.isArray(group)) {
      return { ok: false, error: '"selector" must be an object or array of objects.' };
    }

    const entries = Object.entries(group as Record<string, unknown>);
    if (entries.length === 0) {
      return { ok: false, error: 'Each selector group must contain at least one field rule.' };
    }
    if (entries.length > MAX_SELECTOR_RULES_PER_GROUP) {
      return { ok: false, error: `Selector group has too many rules (max ${MAX_SELECTOR_RULES_PER_GROUP}).` };
    }

    const normalizedGroup: Record<string, string> = {};
    for (const [fieldRaw, patternRaw] of entries) {
      const field = String(fieldRaw).trim();
      if (!field) {
        return { ok: false, error: 'Selector field names must be non-empty strings.' };
      }
      if (typeof patternRaw !== 'string') {
        return { ok: false, error: `Selector pattern for field "${field}" must be a string.` };
      }
      const pattern = patternRaw.trim();
      if (!pattern) {
        return { ok: false, error: `Selector pattern for field "${field}" must be non-empty.` };
      }
      if (pattern.length > MAX_SELECTOR_PATTERN_LEN) {
        return {
          ok: false,
          error: `Selector pattern for field "${field}" is too long (max ${MAX_SELECTOR_PATTERN_LEN} chars).`,
        };
      }
      try {
        // Compile once to fail fast on invalid regex.
        new RegExp(pattern, 'i');
      } catch {
        return { ok: false, error: `Selector pattern for field "${field}" is not a valid regex.` };
      }
      normalizedGroup[field] = pattern;
    }

    normalizedGroups.push(normalizedGroup);
  }

  return {
    ok: true,
    selector: fromArray ? normalizedGroups : normalizedGroups[0],
  };
}

/**
 * CRUD for log_sources.
 * Auth: admin scope required. Parameterized queries only (A03).
 */
export async function registerSourceRoutes(app: FastifyInstance): Promise<void> {
  const db = getDb();

  // ── PARSE PROFILE CATALOG ────────────────────────────────────
  app.get(
    '/api/v1/parse-profiles',
    { preHandler: requireAuth(PERMISSIONS.SYSTEMS_VIEW) },
    async (_request, reply) => {
      return reply.send(listParseProfileSummaries());
    },
  );

  // ── LIST (all or by system) ─────────────────────────────────
  app.get<{ Querystring: { system_id?: string } }>(
    '/api/v1/sources',
    { preHandler: requireAuth(PERMISSIONS.SYSTEMS_VIEW) },
    async (request, reply) => {
      let query = db('log_sources').orderBy('priority', 'asc');
      if (request.query.system_id) {
        query = query.where({ system_id: request.query.system_id });
      }
      const sources = await query.select('*');
      // Parse selector JSON for response (try/catch per row to avoid one corrupt row crashing the endpoint)
      const result = sources.map((s: any) => {
        let selector = s.selector;
        if (typeof selector === 'string') {
          try { selector = JSON.parse(selector); } catch { /* keep as string */ }
        }
        return { ...s, selector };
      });
      return reply.send(result);
    },
  );

  // ── GET BY ID ───────────────────────────────────────────────
  app.get<{ Params: { id: string } }>(
    '/api/v1/sources/:id',
    { preHandler: requireAuth(PERMISSIONS.SYSTEMS_VIEW) },
    async (request, reply) => {
      const source = await db('log_sources').where({ id: request.params.id }).first();
      if (!source) return reply.code(404).send({ error: 'Log source not found' });
      let selector = source.selector;
      if (typeof selector === 'string') {
        try { selector = JSON.parse(selector); } catch { /* keep as string */ }
      }
      return reply.send({ ...source, selector });
    },
  );

  // ── CREATE ──────────────────────────────────────────────────
  app.post<{ Body: CreateLogSourceBody }>(
    '/api/v1/sources',
    { preHandler: requireAuth(PERMISSIONS.SYSTEMS_MANAGE) },
    async (request, reply) => {
      const { system_id, label, selector, priority, parse_profile } = request.body ?? {};

      if (!system_id || typeof system_id !== 'string') {
        return reply.code(400).send({ error: '"system_id" is required.' });
      }
      if (!label || typeof label !== 'string' || label.trim().length === 0) {
        return reply.code(400).send({ error: '"label" is required and must be a non-empty string.' });
      }
      const validatedSelector = validateAndNormalizeSelector(selector);
      if (!validatedSelector.ok) {
        return reply.code(400).send({ error: validatedSelector.error });
      }

      let parseProfileValue: string | null = null;
      if (parse_profile !== undefined && parse_profile !== null && parse_profile !== '') {
        if (typeof parse_profile !== 'string') {
          return reply.code(400).send({ error: '"parse_profile" must be a string or null.' });
        }
        if (!getParseProfile(parse_profile)) {
          return reply.code(400).send({ error: `"parse_profile" "${parse_profile}" is not recognized.` });
        }
        parseProfileValue = parse_profile;
      }

      // Verify system exists
      const system = await db('monitored_systems').where({ id: system_id }).first();
      if (!system) return reply.code(400).send({ error: `System "${system_id}" not found.` });

      const id = uuidv4();
      const now = new Date().toISOString();

      await db('log_sources').insert({
        id,
        system_id,
        label: label.trim(),
        selector: JSON.stringify(validatedSelector.selector),
        priority: priority ?? 0,
        parse_profile: parseProfileValue,
        created_at: now,
        updated_at: now,
      });

      invalidateSourceCache();
      app.log.info(`[${localTimestamp()}] Log source created: id=${id}, label="${label}"`);

      await writeAuditLog(db, {
        actor_name: getActorName(request),
        action: 'source_create',
        resource_type: 'log_source',
        resource_id: id,
        details: { label: label.trim(), system_id, parse_profile: parseProfileValue },
        ip: request.ip,
        user_id: request.currentUser?.id,
        session_id: request.currentSession?.id,
      });

      const created = await db('log_sources').where({ id }).first();
      let createdSelector = created.selector;
      if (typeof createdSelector === 'string') {
        try { createdSelector = JSON.parse(createdSelector); } catch { /* keep as string */ }
      }
      return reply.code(201).send({ ...created, selector: createdSelector });
    },
  );

  // ── UPDATE ──────────────────────────────────────────────────
  app.put<{ Params: { id: string }; Body: UpdateLogSourceBody }>(
    '/api/v1/sources/:id',
    { preHandler: requireAuth(PERMISSIONS.SYSTEMS_MANAGE) },
    async (request, reply) => {
      const { id } = request.params;
      const existing = await db('log_sources').where({ id }).first();
      if (!existing) return reply.code(404).send({ error: 'Log source not found' });

      const { label, selector, priority, parse_profile } = request.body ?? {};
      const updates: Record<string, any> = { updated_at: new Date().toISOString() };

      if (label !== undefined) {
        if (typeof label !== 'string' || label.trim().length === 0) {
          return reply.code(400).send({ error: '"label" must be a non-empty string.' });
        }
        updates.label = label.trim();
      }
      if (selector !== undefined) {
        const validatedSelector = validateAndNormalizeSelector(selector);
        if (!validatedSelector.ok) {
          return reply.code(400).send({ error: validatedSelector.error });
        }
        updates.selector = JSON.stringify(validatedSelector.selector);
      }
      if (priority !== undefined) {
        const parsedPriority = Number(priority);
        if (!Number.isFinite(parsedPriority)) {
          return reply.code(400).send({ error: '"priority" must be a number.' });
        }
        updates.priority = parsedPriority;
      }
      if (parse_profile !== undefined) {
        if (parse_profile === null || parse_profile === '') {
          updates.parse_profile = null;
        } else if (typeof parse_profile !== 'string') {
          return reply.code(400).send({ error: '"parse_profile" must be a string or null.' });
        } else if (!getParseProfile(parse_profile)) {
          return reply.code(400).send({ error: `"parse_profile" "${parse_profile}" is not recognized.` });
        } else {
          updates.parse_profile = parse_profile;
        }
      }

      await db('log_sources').where({ id }).update(updates);
      invalidateSourceCache();

      app.log.info(`[${localTimestamp()}] Log source updated: id=${id}`);

      await writeAuditLog(db, {
        actor_name: getActorName(request),
        action: 'source_update',
        resource_type: 'log_source',
        resource_id: id,
        details: { ...updates },
        ip: request.ip,
        user_id: request.currentUser?.id,
        session_id: request.currentSession?.id,
      });

      const updated = await db('log_sources').where({ id }).first();
      let updatedSelector = updated.selector;
      if (typeof updatedSelector === 'string') {
        try { updatedSelector = JSON.parse(updatedSelector); } catch { /* keep as string */ }
      }
      return reply.send({ ...updated, selector: updatedSelector });
    },
  );

  // ── DELETE ──────────────────────────────────────────────────
  app.delete<{ Params: { id: string } }>(
    '/api/v1/sources/:id',
    { preHandler: requireAuth(PERMISSIONS.SYSTEMS_MANAGE) },
    async (request, reply) => {
      const { id } = request.params;
      const existing = await db('log_sources').where({ id }).first();
      if (!existing) return reply.code(404).send({ error: 'Log source not found' });

      await db('log_sources').where({ id }).del();
      invalidateSourceCache();

      app.log.info(`[${localTimestamp()}] Log source deleted: id=${id}`);

      await writeAuditLog(db, {
        actor_name: getActorName(request),
        action: 'source_delete',
        resource_type: 'log_source',
        resource_id: id,
        details: { label: existing.label },
        ip: request.ip,
        user_id: request.currentUser?.id,
        session_id: request.currentSession?.id,
      });

      return reply.code(204).send();
    },
  );
}
