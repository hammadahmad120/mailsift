import { describe, expect, it } from 'vitest';
import { documentToMarkdown, formatBytes, threadToMarkdown } from '../src/parse/markdown.js';
import type { Document } from '../src/providers/types.js';

function document(overrides: Partial<Document> = {}): Document {
  return {
    id: 'gmail:m1',
    source: 'gmail',
    kind: 'email',
    reference: {
      message_id: 'm1',
      thread_id: 't1',
      link: 'https://mail.google.com/mail/u/0/#all/m1',
    },
    headers: {
      date: '2026-10-14T05:30:00.000Z',
      from: 'Alice Example <alice@example.com>',
      to: ['me@example.com'],
      cc: [],
      subject: 'Weekly report',
    },
    text: 'Hello,\n\nHere is the report.',
    attachments: [
      {
        attachment_id: 'att-1',
        filename: 'report.pdf',
        mime: 'application/pdf',
        size: 183221,
        text: null,
        truncated: false,
        skipped_reason: null,
      },
    ],
    truncated: false,
    ...overrides,
  };
}

describe('formatBytes', () => {
  it('picks a unit', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(900)).toBe('900 B');
    expect(formatBytes(183221)).toBe('179 kB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
    expect(formatBytes(-1)).toBe('unknown size');
  });
});

describe('documentToMarkdown', () => {
  it('renders title, headers, body and attachment list', () => {
    const md = documentToMarkdown(document());

    expect(md).toBe(
      [
        '# Weekly report',
        '',
        '- From: Alice Example <alice@example.com>',
        '- To: me@example.com',
        '- Date: 2026-10-14T05:30:00.000Z',
        '- Message id: `m1`',
        '- Thread id: `t1`',
        '- Link: https://mail.google.com/mail/u/0/#all/m1',
        '',
        '## Body',
        '',
        'Hello,',
        '',
        'Here is the report.',
        '',
        '## Attachments',
        '',
        '- report.pdf (application/pdf, 179 kB)',
        '',
      ].join('\n'),
    );
  });

  it('skips empty headers, shows cc when present, and marks an empty body', () => {
    const md = documentToMarkdown(
      document({
        headers: { date: '', from: '', to: [], cc: ['bob@example.com'], subject: '  ' },
        text: '',
        attachments: [],
      }),
    );

    expect(md.startsWith('# (no subject)\n')).toBe(true);
    expect(md).not.toContain('- From:');
    expect(md).not.toContain('- To:');
    expect(md).not.toContain('- Date:');
    expect(md).toContain('- Cc: bob@example.com');
    expect(md).toContain('_(no body)_');
    expect(md).not.toContain('## Attachments');
  });

  it('keeps the subject on one line', () => {
    const md = documentToMarkdown(
      document({ headers: { ...document().headers, subject: 'Re:\n  broken\tsubject' } }),
    );
    expect(md.split('\n')[0]).toBe('# Re: broken subject');
  });

  it('marks truncation and renders thread_text and extracted attachment text', () => {
    const md = documentToMarkdown(
      document({
        text: 'cut',
        truncated: true,
        thread_text: '--- From a on d ---\nfirst\n\n--- From b on e ---\nsecond',
        attachments: [
          {
            attachment_id: 'a',
            filename: 'notes.txt',
            mime: 'text/plain',
            size: 10,
            text: 'inside the file',
            truncated: true,
            skipped_reason: null,
          },
          {
            attachment_id: 'b',
            filename: 'image.png',
            mime: 'image/png',
            size: 2048,
            text: null,
            truncated: false,
            skipped_reason: 'ATTACHMENT_UNSUPPORTED',
          },
        ],
      }),
    );

    expect(md).toContain('cut\n\n_Body truncated at the configured limit._');
    expect(md).toContain('## Thread\n\n--- From a on d ---');
    expect(md).toContain('- notes.txt (text/plain, 10 B)');
    expect(md).toContain('- image.png (image/png, 2 kB), not extracted: ATTACHMENT_UNSUPPORTED');
    expect(md).toContain(
      '### notes.txt\n\ninside the file\n\n_Body truncated at the configured limit._',
    );
    expect(md).not.toContain('### image.png');
  });
});

describe('threadToMarkdown', () => {
  it('orders messages oldest first with numbered sections and per-message headers', () => {
    const newer = document({
      id: 'gmail:m2',
      reference: { message_id: 'm2', thread_id: 't1', link: 'https://example.com/m2' },
      headers: {
        date: '2026-10-15T09:00:00.000Z',
        from: 'Bob <bob@example.com>',
        to: ['alice@example.com'],
        cc: ['me@example.com'],
        subject: 'Re: Weekly report',
      },
      text: 'Thanks.',
      attachments: [],
    });
    const older = document();

    const md = threadToMarkdown('t1', [newer, older]);

    expect(md.split('\n').slice(0, 5)).toEqual([
      '# Weekly report',
      '',
      '- Thread id: `t1`',
      '- Messages: 2',
      '- Link: https://mail.google.com/mail/u/0/#all/m1',
    ]);
    const first = md.indexOf(
      '## 1. From Alice Example <alice@example.com> on 2026-10-14T05:30:00.000Z',
    );
    const second = md.indexOf('## 2. From Bob <bob@example.com> on 2026-10-15T09:00:00.000Z');
    expect(first).toBeGreaterThan(0);
    expect(second).toBeGreaterThan(first);
    expect(md).toContain('- Cc: me@example.com\n- Message id: `m2`\n\nThanks.');
    expect(md).toContain('- report.pdf (application/pdf, 179 kB)');
    expect(md.endsWith('\n')).toBe(true);
  });

  it('keeps provider order for equal or missing dates and handles an empty thread', () => {
    const a = document({ headers: { ...document().headers, date: '' }, text: 'A' });
    const b = document({ headers: { ...document().headers, date: 'not a date' }, text: 'B' });
    const md = threadToMarkdown('t1', [a, b]);
    expect(md.indexOf('\nA\n')).toBeLessThan(md.indexOf('\nB\n'));
    expect(md).toContain('on unknown date');

    const empty = threadToMarkdown('t9', []);
    expect(empty).toContain('# (no subject)');
    expect(empty).toContain('- Messages: 0');
    expect(empty).toContain('_(no messages)_');
  });
});
