import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { GmailProvider, messageLink } from '../src/providers/gmail/provider.js';
import type { GmailClient } from '../src/providers/gmail/client.js';

function fixture(name: string): unknown {
  return JSON.parse(
    readFileSync(new URL(`./fixtures/gmail/${name}.json`, import.meta.url), 'utf8'),
  );
}

const profileFixture = fixture('profile');
const plain = fixture('message-plain') as { id: string };
const htmlOnly = fixture('message-html-only') as { id: string };
const withAttachments = fixture('message-with-attachments') as { id: string };
const list = fixture('list');
const thread = fixture('thread');

/** Responses keyed by path. Every call is recorded with its query for assertions. */
function fakeClient(
  responses: Record<string, unknown>,
): GmailClient & { get: ReturnType<typeof vi.fn> } {
  const get = vi.fn((path: string) => {
    if (path in responses) return Promise.resolve(responses[path]);
    return Promise.reject(new Error(`unexpected path ${path}`));
  });
  return { get } as GmailClient & { get: ReturnType<typeof vi.fn> };
}

const messageResponses = {
  [`messages/${plain.id}`]: plain,
  [`messages/${htmlOnly.id}`]: htmlOnly,
  [`messages/${withAttachments.id}`]: withAttachments,
};

const now = () => new Date('2026-10-28T12:00:00Z');

describe('GmailProvider.getProfile', () => {
  it('maps the recorded Gmail profile into a MailboxProfile', async () => {
    const client = fakeClient({ profile: profileFixture });
    const provider = new GmailProvider({
      client,
      scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
    });

    const profile = await provider.getProfile();

    expect(profile).toEqual({
      email_address: 'someone@example.com',
      messages_total: 48213,
      threads_total: 31977,
      provider: 'gmail',
      scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
      read_only: true,
    });
    expect(client.get.mock.calls).toEqual([['profile']]);
  });

  it('defaults scopes to an empty list and missing counts to zero', async () => {
    const client = fakeClient({ profile: { emailAddress: 'a@b.c' } });
    const profile = await new GmailProvider({ client }).getProfile();
    expect(profile.scopes).toEqual([]);
    expect(profile.messages_total).toBe(0);
    expect(profile.threads_total).toBe(0);
  });

  it('fails with PROVIDER_ERROR when Google returns no email address', async () => {
    const client = fakeClient({ profile: { messagesTotal: 1 } });
    await expect(new GmailProvider({ client }).getProfile()).rejects.toMatchObject({
      code: 'PROVIDER_ERROR',
    });
  });

  it('exposes exactly the five MailProvider methods', () => {
    const provider = new GmailProvider({ client: fakeClient({}) });
    const methods = Object.getOwnPropertyNames(GmailProvider.prototype).filter(
      (n) => n !== 'constructor',
    );
    expect(methods.sort()).toEqual([
      'getAttachment',
      'getMessage',
      'getProfile',
      'getThread',
      'search',
    ]);
    expect(provider.name).toBe('gmail');
  });

  it('reports getAttachment as not implemented yet', async () => {
    const provider = new GmailProvider({ client: fakeClient({}) });
    await expect(provider.getAttachment('x', 'y')).rejects.toMatchObject({
      code: 'PROVIDER_ERROR',
    });
  });
});

describe('GmailProvider.search', () => {
  it('lists ids with the built query, then fetches each message, returning metadata only', async () => {
    const client = fakeClient({ messages: list, ...messageResponses });
    const provider = new GmailProvider({ client, maxRangeDays: 365, now });

    const result = await provider.search(
      { subject: 'Node', after: '2026-09-01', has_attachment: true },
      { page_size: 25 },
    );

    expect(result.query_used).toBe(
      'subject:(Node) after:2026/09/01 has:attachment -in:spam -in:trash',
    );
    expect(result.result_size_estimate).toBe(43);
    expect(result.next_page_token).toBe('09876543210987654321');
    expect(result.items).toHaveLength(3);

    expect(client.get.mock.calls[0]).toEqual([
      'messages',
      { q: result.query_used, maxResults: 25, pageToken: undefined },
    ]);
    expect(client.get.mock.calls.slice(1)).toEqual([
      [`messages/${plain.id}`, { format: 'full' }],
      [`messages/${htmlOnly.id}`, { format: 'full' }],
      [`messages/${withAttachments.id}`, { format: 'full' }],
    ]);

    const first = result.items[0];
    expect(first).toEqual({
      message_id: '18f3a9c0ffee0001',
      thread_id: '18f3a9c0ffee0001',
      date: '2026-10-14T05:30:00.000Z',
      from: 'Alice Example <alice@example.com>',
      to: ['"Doe, Jane" <jane@example.com>', 'me@example.com'],
      subject: 'Plain text message',
      snippet: 'Hello, Here is the plain text body.',
      attachments: [],
      link: 'https://mail.google.com/mail/u/0/#all/18f3a9c0ffee0001',
    });
    expect(first).not.toHaveProperty('body');
    expect(first).not.toHaveProperty('text');
  });

  it('every item carries a Gmail link in the documented format', async () => {
    const client = fakeClient({ messages: list, ...messageResponses });
    const result = await new GmailProvider({ client, now }).search(
      { subject: 'x' },
      { page_size: 3 },
    );
    for (const item of result.items) {
      expect(item.link).toBe(`https://mail.google.com/mail/u/0/#all/${item.message_id}`);
      expect(item.link).toMatch(/^https:\/\/mail\.google\.com\/mail\/u\/0\/#all\/[A-Za-z0-9_-]+$/);
    }
    expect(messageLink('abc')).toBe('https://mail.google.com/mail/u/0/#all/abc');
  });

  it('lists attachment metadata on items that have them', async () => {
    const client = fakeClient({ messages: list, ...messageResponses });
    const result = await new GmailProvider({ client, now }).search(
      { subject: 'x' },
      { page_size: 3 },
    );
    expect(result.items[2]?.attachments.map((a) => a.filename)).toEqual([
      'report.pdf',
      'notes.docx',
    ]);
  });

  it('passes the page token through and reports the end of results as null', async () => {
    const client = fakeClient({
      messages: { messages: [{ id: plain.id, threadId: plain.id }], resultSizeEstimate: 1 },
      ...messageResponses,
    });
    const result = await new GmailProvider({ client, now }).search(
      { from: 'alice@example.com' },
      { page_size: 10, page_token: 'tok-2' },
    );
    expect(client.get.mock.calls[0]?.[1]).toMatchObject({ maxResults: 10, pageToken: 'tok-2' });
    expect(result.next_page_token).toBeNull();
    expect(result.items).toHaveLength(1);
  });

  it('returns an empty page when Gmail lists nothing', async () => {
    const client = fakeClient({ messages: { resultSizeEstimate: 0 } });
    const result = await new GmailProvider({ client, now }).search(
      { subject: 'zzz' },
      { page_size: 5 },
    );
    expect(result).toEqual({
      query_used: 'subject:(zzz) -in:spam -in:trash',
      result_size_estimate: 0,
      next_page_token: null,
      items: [],
    });
    expect(client.get.mock.calls).toHaveLength(1);
  });

  it('rejects an empty filter set before calling Gmail', async () => {
    const client = fakeClient({});
    await expect(
      new GmailProvider({ client, now }).search({}, { page_size: 5 }),
    ).rejects.toMatchObject({
      code: 'QUERY_EMPTY',
    });
    expect(client.get.mock.calls).toEqual([]);
  });

  it('enforces maxRangeDays before calling Gmail', async () => {
    const client = fakeClient({});
    const provider = new GmailProvider({ client, maxRangeDays: 30, now });
    await expect(
      provider.search({ after: '2026-01-01', before: '2026-06-01' }, { page_size: 5 }),
    ).rejects.toMatchObject({ code: 'RANGE_TOO_WIDE' });
    expect(client.get.mock.calls).toEqual([]);
  });
});

describe('GmailProvider.getMessage', () => {
  it('returns a RawMessage with headers, raw body, attachments and link', async () => {
    const client = fakeClient(messageResponses);
    const raw = await new GmailProvider({ client }).getMessage(withAttachments.id);

    expect(client.get.mock.calls).toEqual([[`messages/${withAttachments.id}`, { format: 'full' }]]);
    expect(raw.message_id).toBe(withAttachments.id);
    expect(raw.thread_id).toBe(withAttachments.id);
    expect(raw.link).toBe(`https://mail.google.com/mail/u/0/#all/${withAttachments.id}`);
    expect(raw.headers.subject).toBe('Message with two attachments');
    expect(raw.body?.kind).toBe('text');
    expect(raw.body?.content).toContain('Here is the plain text body.');
    expect(raw.attachments.map((a) => a.filename)).toEqual(['report.pdf', 'notes.docx']);
  });

  it('keeps html as html; cleaning is phase 3', async () => {
    const client = fakeClient(messageResponses);
    const raw = await new GmailProvider({ client }).getMessage(htmlOnly.id);
    expect(raw.body?.kind).toBe('html');
    expect(raw.body?.content).toContain('<b>HTML</b>');
  });

  it('surfaces a Gmail 404 as NOT_FOUND', async () => {
    const { MailError } = await import('../src/errors.js');
    const client = {
      get: vi.fn().mockRejectedValue(new MailError('NOT_FOUND', 'Gmail resource not found.')),
    } as unknown as GmailClient;
    await expect(
      new GmailProvider({ client }).getMessage('18f3a9c0ffee9999'),
    ).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('rejects a malformed id as NOT_FOUND without calling Gmail', async () => {
    const client = fakeClient({});
    await expect(new GmailProvider({ client }).getMessage('abc/modify')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(new GmailProvider({ client }).getMessage('')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(client.get.mock.calls).toEqual([]);
  });
});

describe('GmailProvider.getThread', () => {
  it('fetches the thread and returns its messages oldest first', async () => {
    const client = fakeClient({ 'threads/18f3a9c0ffee0100': thread });
    const messages = await new GmailProvider({ client }).getThread('18f3a9c0ffee0100');

    expect(client.get.mock.calls).toEqual([['threads/18f3a9c0ffee0100', { format: 'full' }]]);
    expect(messages.map((m) => m.message_id)).toEqual([
      '18f3a9c0ffee0101',
      '18f3a9c0ffee0102',
      '18f3a9c0ffee0103',
    ]);
    expect(messages.map((m) => m.headers.date)).toEqual([
      '2026-10-15T06:00:00.000Z',
      '2026-10-16T06:00:00.000Z',
      '2026-10-17T06:00:00.000Z',
    ]);
    for (const m of messages) expect(m.thread_id).toBe('18f3a9c0ffee0100');
  });

  it('falls back to the Date header for ordering when internalDate is missing', async () => {
    const strip = (m: unknown) => {
      const c = JSON.parse(JSON.stringify(m)) as { internalDate?: string };
      delete c.internalDate;
      return c;
    };
    const t = thread as { messages: unknown[] };
    const client = fakeClient({ 'threads/t': { id: 't', messages: t.messages.map(strip) } });
    const messages = await new GmailProvider({ client }).getThread('t');
    expect(messages.map((m) => m.message_id)).toEqual([
      '18f3a9c0ffee0101',
      '18f3a9c0ffee0102',
      '18f3a9c0ffee0103',
    ]);
  });

  it('returns an empty list for a thread with no messages', async () => {
    const client = fakeClient({ 'threads/t': { id: 't' } });
    await expect(new GmailProvider({ client }).getThread('t')).resolves.toEqual([]);
  });

  it('rejects a malformed thread id as NOT_FOUND without calling Gmail', async () => {
    const client = fakeClient({});
    await expect(new GmailProvider({ client }).getThread('../x')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(client.get.mock.calls).toEqual([]);
  });
});
