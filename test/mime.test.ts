import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  decodeBase64Url,
  findBodyPart,
  listAttachments,
  readHeaders,
  splitAddresses,
  toIsoDate,
  walkParts,
} from '../src/providers/gmail/mime.js';
import type { GmailMessage, GmailPart } from '../src/providers/gmail/mime.js';

function fixture(name: string): GmailMessage {
  return JSON.parse(
    readFileSync(new URL(`./fixtures/gmail/${name}.json`, import.meta.url), 'utf8'),
  ) as GmailMessage;
}

const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64url');

const plain = fixture('message-plain');
const htmlOnly = fixture('message-html-only');
const withAttachments = fixture('message-with-attachments');

describe('decodeBase64Url', () => {
  it('decodes url-safe alphabet without padding as UTF-8', () => {
    expect(decodeBase64Url(b64('héllo ~ ?'))).toBe('héllo ~ ?');
    expect(decodeBase64Url('aGk')).toBe('hi');
    expect(decodeBase64Url('')).toBe('');
  });
});

describe('findBodyPart', () => {
  it('picks the plain body from a single-part message', () => {
    const body = findBodyPart(plain.payload);
    expect(body?.kind).toBe('text');
    expect(body?.content).toContain('Here is the plain text body.');
  });

  it('picks html when there is no plain part', () => {
    const body = findBodyPart(htmlOnly.payload);
    expect(body?.kind).toBe('html');
    expect(body?.content).toContain('<b>HTML</b>');
  });

  it('prefers the nested plain part over html in a mixed message', () => {
    const body = findBodyPart(withAttachments.payload);
    expect(body?.kind).toBe('text');
    expect(body?.content).toContain('Here is the plain text body.');
  });

  it('skips an empty plain part and falls back to html', () => {
    const payload: GmailPart = {
      mimeType: 'multipart/alternative',
      parts: [
        { mimeType: 'text/plain', body: { size: 1, data: b64(' \n') } },
        { mimeType: 'text/html', body: { size: 5, data: b64('<p>x</p>') } },
      ],
    };
    expect(findBodyPart(payload)).toEqual({ kind: 'html', content: '<p>x</p>' });
  });

  it('never treats a text attachment as the body', () => {
    const payload: GmailPart = {
      mimeType: 'multipart/mixed',
      parts: [
        { mimeType: 'text/plain', filename: 'notes.txt', body: { attachmentId: 'a', size: 9 } },
        { mimeType: 'text/html', body: { size: 5, data: b64('<p>y</p>') } },
      ],
    };
    expect(findBodyPart(payload)?.kind).toBe('html');
  });

  it('returns null when there is no readable body', () => {
    expect(findBodyPart(undefined)).toBeNull();
    expect(findBodyPart({ mimeType: 'multipart/mixed', parts: [] })).toBeNull();
  });
});

describe('readHeaders', () => {
  it('reads from, to, cc, subject and an ISO date', () => {
    expect(readHeaders(plain.payload, plain.internalDate)).toEqual({
      date: '2026-10-14T05:30:00.000Z',
      from: 'Alice Example <alice@example.com>',
      to: ['"Doe, Jane" <jane@example.com>', 'me@example.com'],
      cc: ['Bob <bob@example.com>'],
      subject: 'Plain text message',
    });
  });

  it('matches header names case-insensitively and defaults missing ones', () => {
    const payload: GmailPart = {
      headers: [
        { name: 'subject', value: '  spaced   out ' },
        { name: 'FROM', value: 'x@example.com' },
      ],
    };
    expect(readHeaders(payload)).toEqual({
      date: '',
      from: 'x@example.com',
      to: [],
      cc: [],
      subject: 'spaced out',
    });
  });

  it('falls back to internalDate when the Date header is unparseable', () => {
    expect(toIsoDate('not a date', String(Date.parse('2026-10-18T17:30:00Z')))).toBe(
      '2026-10-18T17:30:00.000Z',
    );
    expect(toIsoDate(undefined, undefined)).toBe('');
    expect(toIsoDate('Tue, 14 Oct 2026 09:30:00 +0400')).toBe('2026-10-14T05:30:00.000Z');
  });
});

describe('splitAddresses', () => {
  it('splits on commas outside quotes and angle brackets', () => {
    expect(
      splitAddresses('"Doe, Jane" <jane@example.com>, bob@example.com ,  Carl <c@example.com>'),
    ).toEqual(['"Doe, Jane" <jane@example.com>', 'bob@example.com', 'Carl <c@example.com>']);
  });

  it('handles empty and undefined', () => {
    expect(splitAddresses(undefined)).toEqual([]);
    expect(splitAddresses(' , ')).toEqual([]);
  });
});

describe('listAttachments', () => {
  it('lists the two real attachments with ids, mime types and sizes', () => {
    expect(listAttachments(withAttachments.payload)).toEqual([
      {
        attachment_id: 'ANGjdJ8_report-pdf',
        filename: 'report.pdf',
        mime: 'application/pdf',
        size: 183221,
      },
      {
        attachment_id: 'ANGjdJ8_notes-docx',
        filename: 'notes.docx',
        mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        size: 24680,
      },
    ]);
  });

  it('excludes the inline image', () => {
    const names = listAttachments(withAttachments.payload).map((a) => a.filename);
    expect(names).not.toContain('logo.png');
  });

  it('excludes a Content-ID part with no disposition, keeps one marked attachment', () => {
    const payload: GmailPart = {
      parts: [
        {
          mimeType: 'image/png',
          filename: 'a.png',
          headers: [{ name: 'Content-ID', value: '<a>' }],
          body: { attachmentId: 'id-a', size: 1 },
        },
        {
          mimeType: 'image/png',
          filename: 'b.png',
          headers: [
            { name: 'Content-ID', value: '<b>' },
            { name: 'Content-Disposition', value: 'attachment; filename="b.png"' },
          ],
          body: { attachmentId: 'id-b', size: 2 },
        },
      ],
    };
    expect(listAttachments(payload).map((a) => a.filename)).toEqual(['b.png']);
  });

  it('returns an empty list for messages without attachments', () => {
    expect(listAttachments(plain.payload)).toEqual([]);
    expect(listAttachments(htmlOnly.payload)).toEqual([]);
    expect(listAttachments(undefined)).toEqual([]);
  });
});

describe('walkParts', () => {
  it('visits every part depth-first, parents first', () => {
    const ids = walkParts(withAttachments.payload).map((p) => p.partId);
    expect(ids).toEqual(['', '0', '0.0', '0.1', '0.1.0', '0.1.1', '1', '2']);
  });
});
