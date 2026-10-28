import { MailError } from '../../errors.js';
import { ATTACHMENT_TYPES } from '../types.js';
import type { AttachmentType, SearchFilters } from '../types.js';

/**
 * Turns provider-neutral `SearchFilters` into a Gmail `q` string.
 *
 * Pure: no network, no config lookup, no clock unless `now` is omitted. This is
 * the only place Gmail search syntax is known. Everything a model types ends up
 * here, so every value is sanitized before it touches the query.
 *
 * Design brief: section 8.1 (fields and rules), section 16 (operators used).
 */

export interface QueryOptions {
  /** Longest allowed span between `after` and `before`, or `after` and now. */
  maxRangeDays: number;
  /** Injected for tests. Defaults to the current time. */
  now?: Date;
}

/** Appended to every query. Spam and trash are never searched. */
export const ALWAYS_EXCLUDED = '-in:spam -in:trash';

const MS_PER_DAY = 86_400_000;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Collapse whitespace and drop the characters that have structural meaning in
 * Gmail syntax (quotes and grouping brackets) so a value can never close a
 * group or start a new operator. Returns '' when nothing useful remains.
 */
function sanitize(value: string): string {
  return value
    .replace(/["(){}]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** A single search term: quoted as a phrase when it contains spaces. */
function term(value: string): string {
  const clean = sanitize(value);
  if (clean === '') return '';
  return /\s/.test(clean) ? `"${clean}"` : clean;
}

/**
 * A field whose value is a set of words that must all appear in that field,
 * e.g. `subject:(Node developer)`. More forgiving than a phrase match.
 */
function group(field: string, value: string): string {
  const clean = sanitize(value);
  return clean === '' ? '' : `${field}:(${clean})`;
}

/** Gmail labels use hyphens where the UI shows spaces. */
function labelTerm(value: string): string {
  const clean = sanitize(value).replace(/\s/g, '-');
  return clean === '' ? '' : `label:${clean}`;
}

function terms(values: readonly string[] | undefined): string[] {
  return (values ?? []).map(term).filter((t) => t !== '');
}

/** Parse `YYYY-MM-DD` strictly. The tool schema guarantees the format; this guards the invariant. */
function parseDate(field: 'after' | 'before', value: string): Date {
  const match = DATE_RE.exec(value.trim());
  if (!match) throw new TypeError(`${field} must be a YYYY-MM-DD date, got "${value}"`);
  const [, y, m, d] = match;
  const date = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
  const roundTrips =
    date.getUTCFullYear() === Number(y) &&
    date.getUTCMonth() === Number(m) - 1 &&
    date.getUTCDate() === Number(d);
  if (!roundTrips) throw new TypeError(`${field} is not a real calendar date: "${value}"`);
  return date;
}

function gmailDate(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}/${m}/${d}`;
}

function checkRange(
  after: Date | undefined,
  before: Date | undefined,
  options: QueryOptions,
): void {
  if (!after) return;
  const end = before ?? options.now ?? new Date();
  const days = Math.ceil((end.getTime() - after.getTime()) / MS_PER_DAY);
  if (days > options.maxRangeDays) {
    const until = before ? 'before' : 'today';
    throw new MailError(
      'RANGE_TOO_WIDE',
      `Date range from after to ${until} is ${days} days; the limit is ${options.maxRangeDays}.`,
      `Narrow the date range to at most ${options.maxRangeDays} days.`,
    );
  }
}

function knownAttachmentTypes(values: readonly string[] | undefined): AttachmentType[] {
  const seen = new Set<AttachmentType>();
  for (const v of values ?? []) {
    const lower = v.trim().toLowerCase();
    if ((ATTACHMENT_TYPES as readonly string[]).includes(lower)) seen.add(lower as AttachmentType);
  }
  return [...seen];
}

/**
 * Build the Gmail `q` string.
 *
 * Throws `MailError('QUERY_EMPTY')` when no narrowing filter is set. Attachment
 * flags alone do not count: they would scan the whole mailbox.
 * Throws `MailError('RANGE_TOO_WIDE')` when `after`..`before` (or `after`..now)
 * spans more than `maxRangeDays`.
 */
export function buildQuery(filters: SearchFilters, options: QueryOptions): string {
  const parts: string[] = [];

  const subject = group('subject', filters.subject ?? '');
  const from = group('from', filters.from ?? '');
  const to = group('to', filters.to ?? '');
  const keywords = terms(filters.keywords);
  const anyKeywords = terms(filters.any_keywords);
  const after = filters.after?.trim() ? parseDate('after', filters.after) : undefined;
  const before = filters.before?.trim() ? parseDate('before', filters.before) : undefined;
  const label = labelTerm(filters.label ?? '');
  const rawQuery = (filters.raw_query ?? '').trim();

  const narrowing =
    subject !== '' ||
    from !== '' ||
    to !== '' ||
    keywords.length > 0 ||
    anyKeywords.length > 0 ||
    after !== undefined ||
    before !== undefined ||
    label !== '' ||
    rawQuery !== '';

  if (!narrowing) {
    throw new MailError('QUERY_EMPTY', 'No search filter was given.');
  }

  checkRange(after, before, options);

  if (subject) parts.push(subject);
  if (from) parts.push(from);
  if (to) parts.push(to);
  parts.push(...keywords);
  if (anyKeywords.length === 1) parts.push(anyKeywords[0] as string);
  else if (anyKeywords.length > 1) parts.push(`{${anyKeywords.join(' ')}}`);
  if (after) parts.push(`after:${gmailDate(after)}`);
  if (before) parts.push(`before:${gmailDate(before)}`);
  if (filters.has_attachment === true) parts.push('has:attachment');
  if (filters.has_attachment === false) parts.push('-has:attachment');

  const types = knownAttachmentTypes(filters.attachment_types);
  if (types.length === 1) parts.push(`filename:${types[0] as string}`);
  else if (types.length > 1) parts.push(`(${types.map((t) => `filename:${t}`).join(' OR ')})`);

  if (label) parts.push(label);
  if (rawQuery) parts.push(rawQuery);
  parts.push(ALWAYS_EXCLUDED);

  return parts.join(' ');
}
