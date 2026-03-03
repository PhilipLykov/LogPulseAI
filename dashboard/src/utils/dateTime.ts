/**
 * Format a date/time as DD-MM-YYYY HH:MM:SS (EU format).
 * Returns the original input string when parsing fails.
 */
export function formatEuDateTime(
  input: string | Date | number | null | undefined,
  options?: { includeSeconds?: boolean },
): string {
  if (input === null || input === undefined || input === '') return '—';
  const includeSeconds = options?.includeSeconds ?? true;

  const d = input instanceof Date ? input : new Date(input);
  if (isNaN(d.getTime())) {
    return typeof input === 'string' ? input : String(input);
  }

  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = d.getFullYear();
  const hh = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  const sec = String(d.getSeconds()).padStart(2, '0');

  return includeSeconds
    ? `${dd}-${mm}-${yyyy} ${hh}:${min}:${sec}`
    : `${dd}-${mm}-${yyyy} ${hh}:${min}`;
}

/** Convert EU string "DD-MM-YYYY HH:MM" to ISO string, or '' if invalid. */
export function euToIso(eu: string): string {
  if (!eu || eu.trim().length === 0) return '';
  const m = eu.trim().match(/^(\d{2})-(\d{2})-(\d{4})\s+(\d{2}):(\d{2})$/);
  if (!m) return '';
  const [, dd, mm, yyyy, hh, min] = m;
  const d = new Date(Number(yyyy), Number(mm) - 1, Number(dd), Number(hh), Number(min));
  if (isNaN(d.getTime())) return '';
  return d.toISOString();
}

/** Convert ISO (or parseable date string) to EU "DD-MM-YYYY HH:MM", or '' if invalid. */
export function isoToEu(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = d.getFullYear();
  const hh = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  return `${dd}-${mm}-${yyyy} ${hh}:${min}`;
}

/** Current local time in EU format. */
export function nowEu(): string {
  return isoToEu(new Date().toISOString());
}

/** Today 00:00 in EU format. */
export function todayStartEu(): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return isoToEu(d.toISOString());
}

/** Today 23:59 in EU format. */
export function todayEndEu(): string {
  const d = new Date();
  d.setHours(23, 59, 0, 0);
  return isoToEu(d.toISOString());
}

/** 1 Jan of current year 00:00 in EU format. */
export function yearStartEu(): string {
  const d = new Date();
  d.setMonth(0, 1);
  d.setHours(0, 0, 0, 0);
  return isoToEu(d.toISOString());
}
