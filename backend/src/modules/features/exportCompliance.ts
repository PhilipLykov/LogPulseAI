import type { Knex } from 'knex';
import { localTimestamp } from '../../config/index.js';
import { CRITERIA } from '../../types/index.js';
import { scoreToSeverity, loadSeverityBands } from './severityLabels.js';

export interface ExportParams {
  type: 'csv' | 'json';
  system_ids?: string[];
  from: string;
  to: string;
}

/**
 * Generate a compliance export (CSV or JSON) for a time range.
 * Returns the export data as a string. No secrets or PII included (A02).
 */
export async function generateComplianceExport(
  db: Knex,
  params: ExportParams,
): Promise<{ data: string; filename: string }> {
  const bands = await loadSeverityBands(db);

  // Get windows in range
  let windowQuery = db('windows')
    .where('from_ts', '>=', params.from)
    .where('to_ts', '<=', params.to)
    .orderBy('from_ts', 'asc');

  if (params.system_ids?.length) {
    windowQuery = windowQuery.whereIn('system_id', params.system_ids);
  }

  const windows = await windowQuery.select('*');

  const records = [];

  for (const w of windows) {
    const system = await db('monitored_systems').where({ id: w.system_id }).first();
    const meta = await db('meta_results').where({ window_id: w.id }).first();
    const effectiveScores = await db('effective_scores')
      .where({ window_id: w.id })
      .select('criterion_id', 'effective_value', 'meta_score', 'max_event_score');

    const scoreData: Record<string, any> = {};
    for (const es of effectiveScores) {
      const criterion = CRITERIA.find((c) => c.id === es.criterion_id);
      if (criterion) {
        scoreData[criterion.slug] = {
          effective: es.effective_value,
          severity: scoreToSeverity(es.effective_value, bands),
          meta: es.meta_score,
          max_event: es.max_event_score,
        };
      }
    }

    let metaScores: Record<string, unknown> = {};
    let findings: string[] = [];
    try {
      metaScores = meta?.meta_scores
        ? (typeof meta.meta_scores === 'string' ? JSON.parse(meta.meta_scores) : meta.meta_scores)
        : {};
    } catch { /* malformed JSON — ignore */ }
    try {
      findings = meta?.findings
        ? (typeof meta.findings === 'string' ? JSON.parse(meta.findings) : meta.findings)
        : [];
    } catch { /* malformed JSON — ignore */ }

    records.push({
      system_id: w.system_id,
      system_name: system?.name ?? 'Unknown',
      window_id: w.id,
      window_from: w.from_ts,
      window_to: w.to_ts,
      scores: scoreData,
      analysis_confidence: typeof meta?.analysis_confidence === 'number' ? meta.analysis_confidence : null,
      summary: meta?.summary ?? '',
      findings,
      recommended_action: meta?.recommended_action ?? null,
    });
  }

  const timestamp = localTimestamp().replace(/[: ]/g, '-');

  if (params.type === 'json') {
    return {
      data: JSON.stringify({ generated_at: localTimestamp(), records }, null, 2),
      filename: `compliance-export-${timestamp}.json`,
    };
  }

  // CSV
  const headers = [
    'system_name', 'window_from', 'window_to',
    ...CRITERIA.map((c) => `${c.slug}_effective`),
    ...CRITERIA.map((c) => `${c.slug}_severity`),
    'analysis_confidence',
    'summary', 'findings', 'recommended_action',
  ];

  const rows = records.map((r) => [
    csvEscape(r.system_name),
    csvEscape(r.window_from),
    csvEscape(r.window_to),
    ...CRITERIA.map((c) => csvEscape(r.scores[c.slug]?.effective?.toFixed(3) ?? '')),
    ...CRITERIA.map((c) => csvEscape(r.scores[c.slug]?.severity ?? '')),
    csvEscape(typeof r.analysis_confidence === 'number' ? r.analysis_confidence.toFixed(3) : ''),
    csvEscape(r.summary),
    csvEscape(r.findings.join('; ')),
    csvEscape(r.recommended_action ?? ''),
  ]);

  const csv = [headers.join(','), ...rows.map((r) => r.join(','))].join('\r\n');
  return {
    data: csv,
    filename: `compliance-export-${timestamp}.csv`,
  };
}

/**
 * RFC 4180 compliant CSV escaping with formula injection prevention.
 * Fields starting with =, +, -, @ are prefixed with a tab to prevent
 * spreadsheet formula execution when opened in Excel/Sheets.
 */
function csvEscape(s: string): string {
  // Prevent CSV formula injection (OWASP)
  let safe = s;
  if (/^[=+\-@]/.test(safe)) {
    safe = `\t${safe}`;
  }
  if (safe.includes(',') || safe.includes('"') || safe.includes('\n') || safe.includes('\r')) {
    return `"${safe.replace(/"/g, '""')}"`;
  }
  return safe;
}
