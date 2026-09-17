/**
 * EventSource abstraction layer.
 *
 * Defines the contract for querying events regardless of the underlying
 * data store (PostgreSQL or Elasticsearch).  Every event-related query
 * in the application must go through this interface so that systems can
 * independently choose their storage backend.
 */

// ── Shared filter / result types ─────────────────────────────────

/** Represents one event as returned to callers (dashboard, API, pipeline). */
export interface LogEvent {
  id: string;
  system_id: string;
  system_name?: string;          // populated when joined with monitored_systems
  log_source_id?: string;
  timestamp: string;
  received_at?: string;
  message: string;
  severity?: string;
  host?: string;
  source_ip?: string;
  service?: string;
  facility?: string;
  program?: string;
  trace_id?: string;
  span_id?: string;
  external_id?: string;
  raw?: Record<string, unknown> | string;
  acknowledged_at?: string | null;
  template_id?: string | null;
  normalized_hash?: string;
  scored_at?: string | null;
}

/** Filters for paginated event search. */
export interface EventSearchFilters {
  q?: string;                    // full-text search query
  q_mode?: 'fulltext' | 'contains';
  system_id?: string;
  severity?: string;             // comma-separated severity levels
  host?: string;
  source_ip?: string;
  program?: string;
  service?: string;
  trace_id?: string;
  from?: string;                 // ISO timestamp
  to?: string;                   // ISO timestamp
  sort_by?: string;
  sort_dir?: 'asc' | 'desc';
  page?: number;
  limit?: number;
}

/** Paginated search result. */
export interface EventSearchResult {
  events: LogEvent[];
  total: number;
  page: number;
  limit: number;
  has_more: boolean;
}

/** Facets for filter dropdowns. */
export interface EventFacets {
  severities: string[];
  hosts: string[];
  source_ips: string[];
  programs: string[];
}

/** Result of trace correlation query. */
export interface TraceResult {
  events: LogEvent[];
  total: number;
}

/** Filters for acknowledge / unacknowledge. */
export interface AckFilters {
  system_id?: string;
  from?: string | null;
  to: string;
}

/** Filters for bulk delete. */
export interface BulkDeleteFilters {
  from?: string;
  to?: string;
  system_id?: string;
}

/** Result of a bulk delete operation. */
export interface BulkDeleteResult {
  deleted_events: number;
  deleted_scores: number;
}

// ── The Interface ────────────────────────────────────────────────

/**
 * Storage-agnostic event access interface.
 *
 * Implementations:
 *   - PgEventSource  – reads/writes events in PostgreSQL (current default)
 *   - EsEventSource  – reads events from Elasticsearch (Phase 2)
 */
export interface EventSource {
  // ── Search & retrieval ─────────────────────────────────────

  /** Paginated event search with filters and full-text. */
  searchEvents(filters: EventSearchFilters): Promise<EventSearchResult>;

  /** Facets (distinct values) for filter dropdowns. */
  getFacets(systemId: string | undefined, days: number): Promise<EventFacets>;

  /** Trace correlation: find events sharing a trace/span/message value. */
  traceEvents(
    value: string,
    field: 'trace_id' | 'message' | 'all',
    fromTs: string,
    toTs: string,
    limit: number,
  ): Promise<TraceResult>;

  /** Get events for a system (drill-down). Supports multi-value filters. */
  getSystemEvents(
    systemId: string,
    opts: {
      from?: string;
      to?: string;
      limit: number;
      severity?: string[];
      host?: string[];
      program?: string[];
      service?: string[];
      facility?: string[];
      event_ids?: string[];
    },
  ): Promise<LogEvent[]>;

  /** Count events for a system in a time range (dashboard card). */
  countSystemEvents(
    systemId: string,
    since: string,
  ): Promise<number>;

  // ── AI pipeline ────────────────────────────────────────────

  /**
   * Fetch unscored, unacknowledged events for the scoring pipeline.
   * Returns events that have no corresponding row in event_scores.
   */
  getUnscoredEvents(
    systemId: string | undefined,
    limit: number,
  ): Promise<LogEvent[]>;

  /**
   * Fetch events in a time range for meta-analysis.
   * Supports optional ack filtering.
   */
  getEventsInTimeRange(
    systemId: string,
    fromTs: string,
    toTs: string,
    opts?: { limit?: number; excludeAcknowledged?: boolean },
  ): Promise<LogEvent[]>;

  /** Count events in a time range (for windowing decisions). */
  countEventsInTimeRange(
    systemId: string,
    fromTs: string,
    toTs: string,
  ): Promise<number>;

  // ── Acknowledgment ─────────────────────────────────────────

  /** Acknowledge events in bulk. Returns count of newly acknowledged events. */
  acknowledgeEvents(filters: AckFilters): Promise<number>;

  /** Un-acknowledge events in bulk. Returns count of un-acknowledged events. */
  unacknowledgeEvents(filters: AckFilters): Promise<number>;

  // ── Maintenance & admin ────────────────────────────────────

  /** Delete events older than a cutoff date for a system. Returns count deleted. */
  deleteOldEvents(systemId: string, cutoffIso: string): Promise<BulkDeleteResult>;

  /**
   * Bulk delete events matching filters.
   * Returns counts of deleted events and scores.
   */
  bulkDeleteEvents(filters: BulkDeleteFilters): Promise<BulkDeleteResult>;

  /** Total event count for a system (for stats display). */
  totalEventCount(): Promise<number>;

  /**
   * Cascade-delete all events (and related scores) for a system.
   * Used when a monitored system is deleted.
   */
  cascadeDeleteSystem(systemId: string, trx: unknown): Promise<void>;
}
