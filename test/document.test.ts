import { describe, expect, it } from 'vitest';
import { rawThreadText, toDocument, truncate } from '../src/parse/document.js';
import type { RawMessage } from '../src/providers/types.js';

const raw: RawMessage = {
  message_id: 'm2',
  thread_id: 't1',
  headers: {
    date: '2026-10-14T05:30:00.000Z',
    from: 'Alice <alice@example.com>',
    to: ['me@example.com'],
    cc: ['bob@example.com'],
    subject: 'Hello',
  },
  link: 'https://mail.google.com/mail/u/0/#all/m2',
  body: { kind: 'text', content: 'Body text.' },
  attachments: [{ attachment_id: 'a1', filename: 'f.pdf', mime: 'application/pdf', size: 10 }],
};

describe('truncate', () => {
  it('leaves short text alone and cuts long text', () => {
    expect(truncate('abc', 3)).toEqual({ text: 'abc', truncated: false });
    expect(truncate('abcd', 3)).toEqual({ text: 'abc', truncated: true });
    expect(truncate('', 0)).toEqual({ text: '', truncated: false });
  });
});

describe('toDocument', () => {
  it('builds the brief section 9 shape with a namespaced id', () => {
    const doc = toDocument(raw, { source: 'gmail', maxChars: 1000 });
    expect(doc.id).toBe('gmail:m2');
    expect(doc.source).toBe('gmail');
    expect(doc.kind).toBe('email');
    expect(doc.reference).toEqual({ message_id: 'm2', thread_id: 't1', link: raw.link });
    expect(doc.headers).toEqual(raw.headers);
    expect(doc.text).toBe('Body text.');
    expect(doc.attachments).toEqual([
      { ...raw.attachments[0], text: null, truncated: false, skipped_reason: null },
    ]);
    expect(doc.truncated).toBe(false);
    expect(doc).not.toHaveProperty('thread_text');
  });

  it('does not share arrays with the raw message', () => {
    const doc = toDocument(raw, { source: 'gmail', maxChars: 1000 });
    doc.headers.to.push('x');
    doc.attachments.pop();
    expect(raw.headers.to).toEqual(['me@example.com']);
    expect(raw.attachments).toHaveLength(1);
  });

  it('treats a missing body as empty text', () => {
    const doc = toDocument({ ...raw, body: null }, { source: 'gmail', maxChars: 10 });
    expect(doc.text).toBe('');
    expect(doc.truncated).toBe(false);
  });

  it('marks truncated when either body or thread text is cut', () => {
    const thread = [
      raw,
      { ...raw, message_id: 'm3', body: { kind: 'text' as const, content: 'x'.repeat(100) } },
    ];
    const doc = toDocument(raw, { source: 'gmail', maxChars: 40, thread });
    expect(doc.text).toBe('Body text.');
    expect(doc.thread_text).toHaveLength(40);
    expect(doc.truncated).toBe(true);
  });
});

describe('rawThreadText', () => {
  it('prefixes each message with the separator and keeps the given order', () => {
    const other: RawMessage = {
      ...raw,
      message_id: 'm1',
      headers: { ...raw.headers, from: 'Bob <bob@example.com>', date: '2026-10-13T00:00:00.000Z' },
      body: { kind: 'html', content: '<p>Earlier</p>' },
    };
    expect(rawThreadText([other, raw])).toBe(
      '--- From Bob <bob@example.com> on 2026-10-13T00:00:00.000Z ---\n<p>Earlier</p>\n\n' +
        '--- From Alice <alice@example.com> on 2026-10-14T05:30:00.000Z ---\nBody text.',
    );
  });

  it('falls back to placeholders for missing from or date', () => {
    const bare = { ...raw, headers: { ...raw.headers, from: '', date: '' }, body: null };
    expect(rawThreadText([bare])).toBe('--- From unknown on unknown date ---\n');
    expect(rawThreadText([])).toBe('');
  });
});
