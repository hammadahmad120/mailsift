import { describe, expect, it } from 'vitest';
import { MailError } from '../src/errors.js';
import { ALWAYS_EXCLUDED, buildQuery } from '../src/providers/gmail/query-builder.js';
import type { SearchFilters } from '../src/providers/types.js';

/**
 * This file doubles as the spec for the `mail://search-syntax` resource (phase 6):
 * each test shows one filter field and the Gmail syntax it maps to.
 */

const opts = { maxRangeDays: 365, now: new Date('2026-10-28T12:00:00Z') };

function q(filters: SearchFilters): string {
  return buildQuery(filters, opts);
}

/** The query without the trailing exclusions, for shorter assertions. */
function core(filters: SearchFilters): string {
  const full = q(filters);
  expect(full.endsWith(` ${ALWAYS_EXCLUDED}`)).toBe(true);
  return full.slice(0, -(ALWAYS_EXCLUDED.length + 1));
}

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    if (err instanceof MailError) return err.code;
    throw err;
  }
  throw new Error('expected a MailError');
}

describe('buildQuery: one field at a time', () => {
  it('subject -> subject:(words)', () => {
    expect(core({ subject: 'Node developer' })).toBe('subject:(Node developer)');
  });

  it('from -> from:(value)', () => {
    expect(core({ from: 'alice@example.com' })).toBe('from:(alice@example.com)');
  });

  it('to -> to:(value)', () => {
    expect(core({ to: 'Bob Jones' })).toBe('to:(Bob Jones)');
  });

  it('keywords -> space-joined terms (AND), phrases quoted', () => {
    expect(core({ keywords: ['invoice', 'due date'] })).toBe('invoice "due date"');
  });

  it('any_keywords -> {a b c} group (OR)', () => {
    expect(core({ any_keywords: ['urgent', 'asap', 'right now'] })).toBe(
      '{urgent asap "right now"}',
    );
  });

  it('any_keywords with one entry needs no group', () => {
    expect(core({ any_keywords: ['urgent'] })).toBe('urgent');
  });

  it('after -> after:YYYY/MM/DD', () => {
    expect(core({ after: '2026-09-01' })).toBe('after:2026/09/01');
  });

  it('before -> before:YYYY/MM/DD', () => {
    expect(core({ before: '2026-10-01' })).toBe('before:2026/10/01');
  });

  it('has_attachment true -> has:attachment, false -> -has:attachment', () => {
    expect(core({ subject: 'x', has_attachment: true })).toBe('subject:(x) has:attachment');
    expect(core({ subject: 'x', has_attachment: false })).toBe('subject:(x) -has:attachment');
  });

  it('attachment_types -> filename: ORs', () => {
    expect(core({ subject: 'x', attachment_types: ['pdf'] })).toBe('subject:(x) filename:pdf');
    expect(core({ subject: 'x', attachment_types: ['pdf', 'docx'] })).toBe(
      'subject:(x) (filename:pdf OR filename:docx)',
    );
  });

  it('attachment_types drops duplicates and unknown types', () => {
    const types = ['pdf', 'PDF', 'exe'] as unknown as NonNullable<
      SearchFilters['attachment_types']
    >;
    expect(core({ subject: 'x', attachment_types: types })).toBe('subject:(x) filename:pdf');
  });

  it('label -> label:name with spaces as hyphens', () => {
    expect(core({ label: 'Job Applications' })).toBe('label:Job-Applications');
  });

  it('raw_query is appended as given', () => {
    expect(core({ raw_query: 'older_than:2d larger:1M' })).toBe('older_than:2d larger:1M');
  });
});

describe('buildQuery: whole query', () => {
  it('always ends with -in:spam -in:trash', () => {
    expect(q({ subject: 'x' })).toBe(`subject:(x) ${ALWAYS_EXCLUDED}`);
    expect(q({ raw_query: 'in:spam' })).toBe(`in:spam ${ALWAYS_EXCLUDED}`);
  });

  it('joins fields in a stable order', () => {
    expect(
      q({
        subject: 'Node',
        from: 'alice@example.com',
        keywords: ['remote'],
        any_keywords: ['senior', 'lead'],
        after: '2026-09-01',
        before: '2026-10-01',
        has_attachment: true,
        attachment_types: ['pdf'],
        label: 'Inbox',
        raw_query: 'larger:10K',
      }),
    ).toBe(
      'subject:(Node) from:(alice@example.com) remote {senior lead} after:2026/09/01 before:2026/10/01 has:attachment filename:pdf label:Inbox larger:10K -in:spam -in:trash',
    );
  });
});

describe('buildQuery: escaping', () => {
  it('quotes terms that contain spaces and collapses inner whitespace', () => {
    expect(core({ keywords: ['  due   date  '] })).toBe('"due date"');
  });

  it('strips double quotes so a value cannot break out of a phrase', () => {
    expect(core({ keywords: ['say "hi" now'] })).toBe('"say hi now"');
    expect(core({ subject: '"quoted"' })).toBe('subject:(quoted)');
  });

  it('strips brackets so a value cannot close a group', () => {
    expect(core({ subject: 'a) OR from:(me' })).toBe('subject:(a OR from: me)');
    expect(core({ any_keywords: ['x} in:anywhere {y'] })).toBe('"x in:anywhere y"');
  });

  it('ignores blank values and empty arrays', () => {
    expect(core({ subject: 'x', from: '   ', keywords: [], any_keywords: ['', ' '] })).toBe(
      'subject:(x)',
    );
  });
});

describe('buildQuery: errors', () => {
  it('throws QUERY_EMPTY with no filters', () => {
    expect(codeOf(() => q({}))).toBe('QUERY_EMPTY');
  });

  it('throws QUERY_EMPTY when only blank values are given', () => {
    expect(codeOf(() => q({ subject: '  ', keywords: [''], raw_query: '' }))).toBe('QUERY_EMPTY');
  });

  it('throws QUERY_EMPTY when only attachment flags are given', () => {
    expect(codeOf(() => q({ has_attachment: true }))).toBe('QUERY_EMPTY');
    expect(codeOf(() => q({ attachment_types: ['pdf'] }))).toBe('QUERY_EMPTY');
  });

  it('throws RANGE_TOO_WIDE when after..before exceeds maxRangeDays', () => {
    expect(codeOf(() => q({ after: '2025-01-01', before: '2026-06-01' }))).toBe('RANGE_TOO_WIDE');
  });

  it('accepts a range of exactly maxRangeDays', () => {
    expect(core({ after: '2025-10-28', before: '2026-10-28' })).toBe(
      'after:2025/10/28 before:2026/10/28',
    );
  });

  it('measures after alone against now', () => {
    expect(codeOf(() => q({ after: '2025-01-01' }))).toBe('RANGE_TOO_WIDE');
    expect(core({ after: '2026-01-01' })).toBe('after:2026/01/01');
  });

  it('does not limit before alone', () => {
    expect(core({ before: '2000-01-01' })).toBe('before:2000/01/01');
  });

  it('carries the limit in the RANGE_TOO_WIDE message and hint', () => {
    try {
      buildQuery({ after: '2024-01-01', before: '2026-01-01' }, { maxRangeDays: 90 });
      throw new Error('expected a throw');
    } catch (err) {
      expect(err).toBeInstanceOf(MailError);
      const e = err as MailError;
      expect(e.message).toMatch(/731 days; the limit is 90/);
      expect(e.hint).toMatch(/at most 90 days/);
    }
  });

  it('rejects malformed or impossible dates', () => {
    expect(() => q({ after: '2026/01/01' })).toThrow(TypeError);
    expect(() => q({ before: '2026-02-30' })).toThrow(TypeError);
  });
});
