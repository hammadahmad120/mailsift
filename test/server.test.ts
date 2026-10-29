import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CredentialResolver } from '../src/auth/credentials.js';
import type { ScopeCheck } from '../src/auth/scope-check.js';
import { MailError } from '../src/errors.js';
import { loadConfig } from '../src/config.js';
import type {
  Document,
  MailProvider,
  MailboxProfile,
  MessageIdPage,
  RawAttachment,
  RawMessage,
  SearchResult,
} from '../src/providers/types.js';
import type { CollectResult } from '../src/tools/collect-mail.js';
import type { AttachmentFileResult } from '../src/tools/get-attachment-file.js';
import type { AttachmentTextResult } from '../src/tools/get-attachment-text.js';
import { createDefaultDeps, createServer, type ServerDeps } from '../src/server.js';

const FAKE_TOKEN = 'ya29.test-token-must-never-leak';
const READONLY = 'https://www.googleapis.com/auth/gmail.readonly';

const profile: MailboxProfile = {
  email_address: 'someone@example.com',
  messages_total: 48213,
  threads_total: 31977,
  provider: 'gmail',
  scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
  read_only: true,
};

function fakeProvider(overrides: Partial<MailProvider> = {}): MailProvider {
  const notCalled = () => Promise.reject(new Error('should not be called'));
  return {
    name: 'gmail',
    getProfile: () => Promise.resolve(profile),
    search: notCalled,
    listMessageIds: notCalled,
    getMessage: notCalled,
    getThread: notCalled,
    getAttachment: notCalled,
    ...overrides,
  };
}

function fakeDeps(overrides: Partial<ServerDeps> = {}): ServerDeps {
  return {
    config: loadConfig({}),
    resolveCredentials: () => Promise.resolve({ provider: 'gmail', token: FAKE_TOKEN }),
    checkScope: () => Promise.resolve({ scopes: [READONLY] }),
    createProvider: () => fakeProvider(),
    ...overrides,
  };
}

const cleanups: Array<() => Promise<void>> = [];

/** Connect a real MCP Client to the server over the SDK's in-memory transport. */
async function connect(deps: ServerDeps): Promise<Client> {
  const server = createServer(deps);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  cleanups.push(async () => {
    await client.close();
    await server.close();
  });
  return client;
}

function textOf(result: Awaited<ReturnType<Client['callTool']>>, index: number): string {
  const content = result.content as Array<{ type: string; text?: string }>;
  const block = content[index];
  if (!block || block.type !== 'text' || typeof block.text !== 'string') {
    throw new Error(`content[${index}] is not a text block`);
  }
  return block.text;
}

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

describe('createServer', () => {
  it('lists the tools, all read-only, and never leaks the token', async () => {
    const client = await connect(fakeDeps());

    const { tools } = await client.listTools();

    expect(tools.map((t) => t.name).sort()).toEqual([
      'collect_mail',
      'get_attachment_file',
      'get_attachment_text',
      'get_email',
      'get_mailbox_profile',
      'search_mail',
    ]);
    for (const tool of tools) {
      expect(tool.annotations).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      });
      expect(tool.inputSchema).toMatchObject({ type: 'object' });
    }
    const profileTool = tools.find((t) => t.name === 'get_mailbox_profile')!;
    expect(Object.keys(profileTool.inputSchema.properties ?? {})).toEqual([]);
    expect(JSON.stringify(tools)).not.toContain(FAKE_TOKEN);
  });

  it('describes every search_mail field from the brief', async () => {
    const client = await connect(fakeDeps());
    const { tools } = await client.listTools();
    const search = tools.find((t) => t.name === 'search_mail')!;
    const props = search.inputSchema.properties ?? {};
    expect(Object.keys(props).sort()).toEqual([
      'after',
      'any_keywords',
      'attachment_types',
      'before',
      'from',
      'has_attachment',
      'keywords',
      'label',
      'page_size',
      'page_token',
      'raw_query',
      'subject',
      'to',
    ]);
    expect(search.inputSchema.required ?? []).toEqual([]);
    for (const [name, prop] of Object.entries(props)) {
      expect((prop as { description?: string }).description, name).toBeTruthy();
    }
    expect(search.description).toContain('never message bodies');
  });
});

describe('get_mailbox_profile', () => {
  it('returns the profile as a JSON text block plus a summary line', async () => {
    const createProvider = vi.fn(() => fakeProvider());
    const client = await connect(fakeDeps({ createProvider }));

    const result = await client.callTool({ name: 'get_mailbox_profile', arguments: {} });

    expect(result.isError).toBeFalsy();
    expect(result.content).toHaveLength(2);
    expect(JSON.parse(textOf(result, 0))).toEqual(profile);
    expect(textOf(result, 1)).toContain('someone@example.com');
    expect(textOf(result, 1)).toContain('48213');
    expect(createProvider).toHaveBeenCalledWith({ provider: 'gmail', token: FAKE_TOKEN }, [
      READONLY,
    ]);
  });

  it('builds a fresh provider per call and passes the handler extra to the resolver', async () => {
    const resolveCredentials = vi.fn<CredentialResolver>(() =>
      Promise.resolve({ provider: 'gmail', token: FAKE_TOKEN }),
    );
    const createProvider = vi.fn(() => fakeProvider());
    const client = await connect(fakeDeps({ resolveCredentials, createProvider }));

    await client.callTool({ name: 'get_mailbox_profile', arguments: {} });
    await client.callTool({ name: 'get_mailbox_profile', arguments: {} });

    expect(resolveCredentials).toHaveBeenCalledTimes(2);
    expect(resolveCredentials.mock.calls[0]?.[0]).toBeDefined();
    expect(createProvider).toHaveBeenCalledTimes(2);
  });

  it('returns a structured tool error when no credentials are configured', async () => {
    const client = await connect(
      fakeDeps({
        resolveCredentials: () => Promise.reject(new MailError('AUTH_MISSING_TOKEN')),
      }),
    );

    const result = await client.callTool({ name: 'get_mailbox_profile', arguments: {} });

    expect(result.isError).toBe(true);
    expect(JSON.parse(textOf(result, 0))).toEqual({
      code: 'AUTH_MISSING_TOKEN',
      message: 'AUTH_MISSING_TOKEN',
      hint: 'Connect a mailbox and retry.',
    });
  });

  it('passes provider MailErrors through with their code and hint', async () => {
    const client = await connect(
      fakeDeps({
        createProvider: () =>
          fakeProvider({
            getProfile: () =>
              Promise.reject(new MailError('AUTH_TOKEN_INVALID', 'Google rejected the token.')),
          }),
      }),
    );

    const result = await client.callTool({ name: 'get_mailbox_profile', arguments: {} });

    expect(result.isError).toBe(true);
    expect(JSON.parse(textOf(result, 0))).toMatchObject({
      code: 'AUTH_TOKEN_INVALID',
      message: 'Google rejected the token.',
    });
  });

  it('hides unknown errors behind PROVIDER_ERROR and never leaks the token', async () => {
    const client = await connect(
      fakeDeps({
        createProvider: () =>
          fakeProvider({
            getProfile: () => Promise.reject(new Error(`boom with ${FAKE_TOKEN}`)),
          }),
      }),
    );

    const result = await client.callTool({ name: 'get_mailbox_profile', arguments: {} });

    expect(result.isError).toBe(true);
    const body = JSON.parse(textOf(result, 0)) as { code: string; message: string };
    expect(body.code).toBe('PROVIDER_ERROR');
    expect(body.message).not.toContain('boom');
    expect(JSON.stringify(result)).not.toContain(FAKE_TOKEN);
  });
});

const searchResult: SearchResult = {
  query_used: 'subject:(Node) after:2026/09/01 -in:spam -in:trash',
  result_size_estimate: 43,
  next_page_token: 'tok-2',
  items: [
    {
      message_id: '18f3a9c0ffee0001',
      thread_id: '18f3a9c0ffee0001',
      date: '2026-10-14T05:30:00.000Z',
      from: 'Alice Example <alice@example.com>',
      to: ['me@example.com'],
      subject: 'Plain text message',
      snippet: 'Hello, Here is the plain text body.',
      attachments: [],
      link: 'https://mail.google.com/mail/u/0/#all/18f3a9c0ffee0001',
    },
  ],
};

describe('search_mail', () => {
  it('passes filters and paging to the provider and returns the result plus a summary', async () => {
    const search = vi.fn<MailProvider['search']>(() => Promise.resolve(searchResult));
    const client = await connect(fakeDeps({ createProvider: () => fakeProvider({ search }) }));

    const result = await client.callTool({
      name: 'search_mail',
      arguments: { subject: 'Node', after: '2026-09-01', attachment_types: ['pdf'], page_size: 10 },
    });

    expect(result.isError).toBeFalsy();
    expect(search).toHaveBeenCalledWith(
      { subject: 'Node', after: '2026-09-01', attachment_types: ['pdf'] },
      { page_size: 10 },
    );
    const body = JSON.parse(textOf(result, 0)) as SearchResult;
    expect(body).toEqual(searchResult);
    expect(body.query_used).toBe(searchResult.query_used);
    expect(body.items[0]?.link).toBe('https://mail.google.com/mail/u/0/#all/18f3a9c0ffee0001');
    expect(body.next_page_token).toBe('tok-2');
    expect(textOf(result, 1)).toContain('43');
    expect(textOf(result, 1)).toContain('showing 1');
    expect(textOf(result, 1)).toContain('More pages');
  });

  it('defaults page_size to 25, clamps it to MAX_PAGE_SIZE, and passes page_token through', async () => {
    const search = vi.fn<MailProvider['search']>(() => Promise.resolve(searchResult));
    const client = await connect(
      fakeDeps({
        config: loadConfig({ MAX_PAGE_SIZE: '50' }),
        createProvider: () => fakeProvider({ search }),
      }),
    );

    await client.callTool({ name: 'search_mail', arguments: { from: 'a@b.c' } });
    await client.callTool({
      name: 'search_mail',
      arguments: { from: 'a@b.c', page_size: 500, page_token: 'tok-2' },
    });

    expect(search.mock.calls[0]?.[1]).toEqual({ page_size: 25 });
    expect(search.mock.calls[1]?.[1]).toEqual({ page_size: 50, page_token: 'tok-2' });
  });

  it('drops blank fields and empty lists before calling the provider', async () => {
    const search = vi.fn<MailProvider['search']>(() => Promise.resolve(searchResult));
    const client = await connect(fakeDeps({ createProvider: () => fakeProvider({ search }) }));

    await client.callTool({
      name: 'search_mail',
      arguments: {
        subject: ' Node ',
        from: '',
        to: '   ',
        keywords: ['', ' remote '],
        any_keywords: [],
        after: '',
        attachment_types: [],
        label: '',
        raw_query: '',
        page_token: '',
      },
    });

    expect(search).toHaveBeenCalledWith(
      { subject: 'Node', keywords: ['remote'] },
      { page_size: 25 },
    );
  });

  it('returns QUERY_EMPTY as a structured error, not a crash', async () => {
    const client = await connect(
      fakeDeps({
        createProvider: () =>
          fakeProvider({
            search: () =>
              Promise.reject(new MailError('QUERY_EMPTY', 'No search filter was given.')),
          }),
      }),
    );

    const result = await client.callTool({ name: 'search_mail', arguments: {} });

    expect(result.isError).toBe(true);
    expect(JSON.parse(textOf(result, 0))).toMatchObject({
      code: 'QUERY_EMPTY',
      hint: expect.stringContaining('at least one') as string,
    });
  });

  it('rejects a malformed date at the schema before touching credentials', async () => {
    const resolveCredentials = vi.fn<CredentialResolver>();
    const client = await connect(fakeDeps({ resolveCredentials }));

    const result = await client.callTool({
      name: 'search_mail',
      arguments: { after: '2026/09/01' },
    });

    expect(result.isError).toBe(true);
    expect(textOf(result, 0)).toMatch(/YYYY-MM-DD/);
    expect(resolveCredentials).not.toHaveBeenCalled();
  });
});

function rawMessage(overrides: Partial<RawMessage> = {}): RawMessage {
  return {
    message_id: '18f3a9c0ffee0001',
    thread_id: '18f3a9c0ffee0100',
    headers: {
      date: '2026-10-14T05:30:00.000Z',
      from: 'Alice Example <alice@example.com>',
      to: ['me@example.com'],
      cc: [],
      subject: 'Plain text message',
    },
    link: 'https://mail.google.com/mail/u/0/#all/18f3a9c0ffee0001',
    body: { kind: 'text', content: 'Hello,\n\nHere is the plain text body.\n' },
    attachments: [
      { attachment_id: 'att-1', filename: 'report.pdf', mime: 'application/pdf', size: 183221 },
    ],
    ...overrides,
  };
}

describe('get_email', () => {
  it('returns a Document with clean body, listed attachments and no thread by default', async () => {
    const getMessage = vi.fn<MailProvider['getMessage']>(() => Promise.resolve(rawMessage()));
    const getThread = vi.fn<MailProvider['getThread']>();
    const client = await connect(
      fakeDeps({ createProvider: () => fakeProvider({ getMessage, getThread }) }),
    );

    const result = await client.callTool({
      name: 'get_email',
      arguments: { message_id: '18f3a9c0ffee0001' },
    });

    expect(result.isError).toBeFalsy();
    expect(getMessage).toHaveBeenCalledWith('18f3a9c0ffee0001');
    expect(getThread).not.toHaveBeenCalled();
    const doc = JSON.parse(textOf(result, 0)) as Document;
    expect(doc).toEqual({
      id: 'gmail:18f3a9c0ffee0001',
      source: 'gmail',
      kind: 'email',
      reference: {
        message_id: '18f3a9c0ffee0001',
        thread_id: '18f3a9c0ffee0100',
        link: 'https://mail.google.com/mail/u/0/#all/18f3a9c0ffee0001',
      },
      headers: {
        date: '2026-10-14T05:30:00.000Z',
        from: 'Alice Example <alice@example.com>',
        to: ['me@example.com'],
        cc: [],
        subject: 'Plain text message',
      },
      text: 'Hello,\n\nHere is the plain text body.',
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
    });
    expect(doc).not.toHaveProperty('thread_text');
    expect(textOf(result, 1)).toContain('Plain text message');
    expect(textOf(result, 1)).toContain('1 attachment');
  });

  it('truncates the body at max_chars and sets the flag', async () => {
    const long = 'x'.repeat(5000);
    const client = await connect(
      fakeDeps({
        createProvider: () =>
          fakeProvider({
            getMessage: () =>
              Promise.resolve(rawMessage({ body: { kind: 'text', content: long } })),
          }),
      }),
    );

    const result = await client.callTool({
      name: 'get_email',
      arguments: { message_id: '18f3a9c0ffee0001', max_chars: 100 },
    });

    const doc = JSON.parse(textOf(result, 0)) as Document;
    expect(doc.text).toBe('x'.repeat(100));
    expect(doc.truncated).toBe(true);
    expect(textOf(result, 1)).toContain('truncated');
  });

  it('uses MAX_MESSAGE_CHARS as the default cap', async () => {
    const client = await connect(
      fakeDeps({
        config: loadConfig({ MAX_MESSAGE_CHARS: '10' }),
        createProvider: () =>
          fakeProvider({
            getMessage: () =>
              Promise.resolve(rawMessage({ body: { kind: 'text', content: 'twelve chars' } })),
          }),
      }),
    );
    const result = await client.callTool({
      name: 'get_email',
      arguments: { message_id: '18f3a9c0ffee0001' },
    });
    const doc = JSON.parse(textOf(result, 0)) as Document;
    expect(doc.text).toBe('twelve cha');
    expect(doc.truncated).toBe(true);
  });

  it('adds thread_text with a separator per message when include_thread is true', async () => {
    const first = rawMessage({
      message_id: 'm1',
      headers: {
        ...rawMessage().headers,
        date: '2026-10-13T05:30:00.000Z',
        from: 'Bob <bob@example.com>',
      },
      body: { kind: 'text', content: 'First message.' },
    });
    const second = rawMessage({ body: { kind: 'text', content: 'Second message.' } });
    const getThread = vi.fn<MailProvider['getThread']>(() => Promise.resolve([first, second]));
    const client = await connect(
      fakeDeps({
        createProvider: () =>
          fakeProvider({ getMessage: () => Promise.resolve(second), getThread }),
      }),
    );

    const result = await client.callTool({
      name: 'get_email',
      arguments: { message_id: '18f3a9c0ffee0001', include_thread: true },
    });

    expect(getThread).toHaveBeenCalledWith('18f3a9c0ffee0100');
    const doc = JSON.parse(textOf(result, 0)) as Document;
    expect(doc.text).toBe('Second message.');
    expect(doc.thread_text).toBe(
      '--- From Bob <bob@example.com> on 2026-10-13T05:30:00.000Z ---\nFirst message.\n\n' +
        '--- From Alice Example <alice@example.com> on 2026-10-14T05:30:00.000Z ---\nSecond message.',
    );
    expect(textOf(result, 1)).toContain('thread of 2');
  });

  it('cleans the body: html converted, quoted reply and signature removed', async () => {
    const html =
      '<div dir="ltr">Sounds good, see you Thursday.</div><div><br></div>' +
      '<div class="gmail_signature">Alice Example<br>Head of Ops</div>' +
      '<div class="gmail_quote">On Mon, Bob wrote:<blockquote>Thursday?</blockquote></div>';
    const client = await connect(
      fakeDeps({
        createProvider: () =>
          fakeProvider({
            getMessage: () =>
              Promise.resolve(rawMessage({ body: { kind: 'html', content: html } })),
          }),
      }),
    );
    const result = await client.callTool({
      name: 'get_email',
      arguments: { message_id: '18f3a9c0ffee0001' },
    });
    expect((JSON.parse(textOf(result, 0)) as Document).text).toBe('Sounds good, see you Thursday.');
  });

  it('attachments: "text" fetches each attachment with ids from the same read and fills text', async () => {
    const { provider, getMessage, getAttachment } = attachmentProvider();
    const client = await connect(fakeDeps({ createProvider: () => provider }));

    const result = await client.callTool({
      name: 'get_email',
      arguments: { message_id: '18f3a9c0ffee0001', attachments: 'text' },
    });

    expect(result.isError).toBeFalsy();
    expect(getMessage).toHaveBeenCalledTimes(1);
    expect(getAttachment).toHaveBeenCalledWith('18f3a9c0ffee0001', 'att-1');
    const doc = JSON.parse(textOf(result, 0)) as Document;
    expect(doc.attachments).toHaveLength(1);
    expect(doc.attachments[0]).toMatchObject({
      attachment_id: 'att-1',
      filename: 'report.pdf',
      truncated: false,
      skipped_reason: null,
    });
    expect(doc.attachments[0]?.text).toContain('Quarterly report for Example Co.');
    expect(textOf(result, 1)).toContain('1 of 1 attachment(s) extracted');
  });

  it('attachments: "text" caps each attachment at max_attachment_chars', async () => {
    const { provider } = attachmentProvider();
    const client = await connect(fakeDeps({ createProvider: () => provider }));
    const result = await client.callTool({
      name: 'get_email',
      arguments: { message_id: '18f3a9c0ffee0001', attachments: 'text', max_attachment_chars: 9 },
    });
    const doc = JSON.parse(textOf(result, 0)) as Document;
    expect(doc.attachments[0]?.text).toBe('Quarterly');
    expect(doc.attachments[0]?.truncated).toBe(true);
    expect(doc.truncated).toBe(false);
  });

  it('attachments: "text" marks one failing attachment as skipped and keeps the rest', async () => {
    const two = rawMessage({
      attachments: [
        { attachment_id: 'bad', filename: 'old.pdf', mime: 'application/pdf', size: 1 },
        { attachment_id: 'att-1', filename: 'report.pdf', mime: 'application/pdf', size: 940 },
        { attachment_id: 'zip', filename: 'all.zip', mime: 'application/zip', size: 3 },
      ],
    });
    const getAttachment = vi.fn<MailProvider['getAttachment']>((_m, id) =>
      id === 'bad'
        ? Promise.reject(new MailError('NOT_FOUND', 'stale'))
        : Promise.resolve(
            rawAttachment({
              attachment_id: id,
              bytes: id === 'zip' ? new Uint8Array(3) : samplePdf,
            }),
          ),
    );
    const client = await connect(
      fakeDeps({
        createProvider: () =>
          fakeProvider({ getMessage: () => Promise.resolve(two), getAttachment }),
      }),
    );

    const result = await client.callTool({
      name: 'get_email',
      arguments: { message_id: '18f3a9c0ffee0001', attachments: 'text' },
    });

    expect(result.isError).toBeFalsy();
    const doc = JSON.parse(textOf(result, 0)) as Document;
    expect(doc.attachments.map((a) => [a.filename, a.skipped_reason, a.text === null])).toEqual([
      ['old.pdf', 'PARSE_FAILED', true],
      ['report.pdf', null, false],
      ['all.zip', 'ATTACHMENT_UNSUPPORTED', true],
    ]);
    expect(textOf(result, 1)).toContain('1 of 3 attachment(s) extracted');
  });

  it('attachments: "none" omits the list and "list" leaves text null without fetching', async () => {
    const { provider, getAttachment } = attachmentProvider();
    const client = await connect(fakeDeps({ createProvider: () => provider }));

    const none = await client.callTool({
      name: 'get_email',
      arguments: { message_id: '18f3a9c0ffee0001', attachments: 'none' },
    });
    expect((JSON.parse(textOf(none, 0)) as Document).attachments).toEqual([]);

    const list = await client.callTool({
      name: 'get_email',
      arguments: { message_id: '18f3a9c0ffee0001', attachments: 'list' },
    });
    expect((JSON.parse(textOf(list, 0)) as Document).attachments[0]?.text).toBeNull();
    expect(getAttachment).not.toHaveBeenCalled();
  });

  it('returns NOT_FOUND as a structured error', async () => {
    const client = await connect(
      fakeDeps({
        createProvider: () =>
          fakeProvider({
            getMessage: () =>
              Promise.reject(new MailError('NOT_FOUND', 'Gmail resource not found.')),
          }),
      }),
    );
    const result = await client.callTool({ name: 'get_email', arguments: { message_id: 'nope' } });
    expect(result.isError).toBe(true);
    expect(JSON.parse(textOf(result, 0))).toMatchObject({ code: 'NOT_FOUND' });
  });

  it('requires message_id at the schema', async () => {
    const resolveCredentials = vi.fn<CredentialResolver>();
    const client = await connect(fakeDeps({ resolveCredentials }));
    const result = await client.callTool({ name: 'get_email', arguments: {} });
    expect(result.isError).toBe(true);
    expect(resolveCredentials).not.toHaveBeenCalled();
  });
});

const EVERY_TOOL: Array<{ name: string; arguments: Record<string, unknown> }> = [
  { name: 'get_mailbox_profile', arguments: {} },
  { name: 'search_mail', arguments: { subject: 'x' } },
  { name: 'get_email', arguments: { message_id: 'm1' } },
  { name: 'get_attachment_text', arguments: { message_id: 'm1', attachment_id: 'a1' } },
  { name: 'get_attachment_file', arguments: { message_id: 'm1', filename: 'a.pdf' } },
  { name: 'collect_mail', arguments: { subject: 'x' } },
];

const samplePdf = new Uint8Array(
  readFileSync(new URL('./fixtures/attachments/sample.pdf', import.meta.url)),
);

function rawAttachment(overrides: Partial<RawAttachment> = {}): RawAttachment {
  return { attachment_id: 'att-1', size: samplePdf.byteLength, bytes: samplePdf, ...overrides };
}

/** A provider whose message lists report.pdf as att-1 and serves its bytes. */
function attachmentProvider(overrides: Partial<MailProvider> = {}): {
  provider: MailProvider;
  getMessage: ReturnType<typeof vi.fn<MailProvider['getMessage']>>;
  getAttachment: ReturnType<typeof vi.fn<MailProvider['getAttachment']>>;
} {
  const getMessage = vi.fn<MailProvider['getMessage']>(() => Promise.resolve(rawMessage()));
  const getAttachment = vi.fn<MailProvider['getAttachment']>(() =>
    Promise.resolve(rawAttachment()),
  );
  return {
    provider: fakeProvider({ getMessage, getAttachment, ...overrides }),
    getMessage,
    getAttachment,
  };
}

describe('get_attachment_text', () => {
  it('reads the message, matches the attachment_id, fetches with it, parses, returns text with pages', async () => {
    const { provider, getMessage, getAttachment } = attachmentProvider();
    const client = await connect(fakeDeps({ createProvider: () => provider }));

    const result = await client.callTool({
      name: 'get_attachment_text',
      arguments: { message_id: '18f3a9c0ffee0001', attachment_id: 'att-1' },
    });

    expect(result.isError).toBeFalsy();
    expect(getMessage).toHaveBeenCalledWith('18f3a9c0ffee0001');
    expect(getAttachment).toHaveBeenCalledWith('18f3a9c0ffee0001', 'att-1');
    const body = JSON.parse(textOf(result, 0)) as AttachmentTextResult;
    expect(body).toMatchObject({
      attachment_id: 'att-1',
      filename: 'report.pdf',
      mime: 'application/pdf',
      size: 940,
      truncated: false,
      pages: 2,
      skipped_reason: null,
    });
    expect(body.text).toContain('Quarterly report for Example Co.');
    expect(textOf(result, 1)).toContain('2 page(s)');
  });

  it('finds the attachment by filename, case-insensitive', async () => {
    const { provider, getAttachment } = attachmentProvider();
    const client = await connect(fakeDeps({ createProvider: () => provider }));

    const result = await client.callTool({
      name: 'get_attachment_text',
      arguments: { message_id: '18f3a9c0ffee0001', filename: 'REPORT.pdf' },
    });

    expect(result.isError).toBeFalsy();
    expect(getAttachment).toHaveBeenCalledWith('18f3a9c0ffee0001', 'att-1');
  });

  it('uses the fresh id from the message when the given attachment_id is stale', async () => {
    const { provider, getAttachment } = attachmentProvider();
    const client = await connect(fakeDeps({ createProvider: () => provider }));

    const withName = await client.callTool({
      name: 'get_attachment_text',
      arguments: {
        message_id: '18f3a9c0ffee0001',
        attachment_id: 'stale-id',
        filename: 'report.pdf',
      },
    });
    expect(withName.isError).toBeFalsy();

    const onlyOne = await client.callTool({
      name: 'get_attachment_text',
      arguments: { message_id: '18f3a9c0ffee0001', attachment_id: 'stale-id' },
    });
    expect(onlyOne.isError).toBeFalsy();

    expect(getAttachment.mock.calls).toEqual([
      ['18f3a9c0ffee0001', 'att-1'],
      ['18f3a9c0ffee0001', 'att-1'],
    ]);
    expect((JSON.parse(textOf(onlyOne, 0)) as AttachmentTextResult).attachment_id).toBe('att-1');
  });

  it('is NOT_FOUND with the filenames when a stale id meets several attachments and no filename', async () => {
    const two = rawMessage({
      attachments: [
        { attachment_id: 'att-1', filename: 'report.pdf', mime: 'application/pdf', size: 1 },
        { attachment_id: 'att-2', filename: 'notes.docx', mime: 'application/x', size: 1 },
      ],
    });
    const { provider, getAttachment } = attachmentProvider({
      getMessage: () => Promise.resolve(two),
    });
    const client = await connect(fakeDeps({ createProvider: () => provider }));

    const result = await client.callTool({
      name: 'get_attachment_text',
      arguments: { message_id: '18f3a9c0ffee0001', attachment_id: 'stale-id' },
    });

    expect(result.isError).toBe(true);
    expect(JSON.parse(textOf(result, 0))).toMatchObject({
      code: 'NOT_FOUND',
      hint: expect.stringContaining('report.pdf, notes.docx') as string,
    });
    expect(getAttachment).not.toHaveBeenCalled();
  });

  it('returns NOT_FOUND with the available filenames when the name does not match', async () => {
    const { provider } = attachmentProvider();
    const client = await connect(fakeDeps({ createProvider: () => provider }));
    const result = await client.callTool({
      name: 'get_attachment_text',
      arguments: { message_id: '18f3a9c0ffee0001', filename: 'missing.pdf' },
    });
    expect(result.isError).toBe(true);
    expect(JSON.parse(textOf(result, 0))).toMatchObject({
      code: 'NOT_FOUND',
      hint: expect.stringContaining('report.pdf') as string,
    });
  });

  it('treats a blank attachment_id as absent, as MCP Inspector sends it', async () => {
    const { provider, getAttachment } = attachmentProvider();
    const client = await connect(fakeDeps({ createProvider: () => provider }));
    const result = await client.callTool({
      name: 'get_attachment_text',
      arguments: { message_id: '18f3a9c0ffee0001', attachment_id: '', filename: ' report.pdf ' },
    });
    expect(result.isError).toBeFalsy();
    expect(getAttachment).toHaveBeenCalledWith('18f3a9c0ffee0001', 'att-1');
  });

  it('refuses a call with neither attachment_id nor filename', async () => {
    const { provider, getMessage, getAttachment } = attachmentProvider();
    const client = await connect(fakeDeps({ createProvider: () => provider }));
    const result = await client.callTool({
      name: 'get_attachment_text',
      arguments: { message_id: '18f3a9c0ffee0001' },
    });
    expect(result.isError).toBe(true);
    expect(JSON.parse(textOf(result, 0))).toMatchObject({ code: 'NOT_FOUND' });
    expect(getMessage).not.toHaveBeenCalled();
    expect(getAttachment).not.toHaveBeenCalled();
  });

  it('returns a skipped attachment as a value, not an error', async () => {
    const zipMessage = rawMessage({
      attachments: [
        { attachment_id: 'att-1', filename: 'all.zip', mime: 'application/zip', size: 3 },
      ],
    });
    const { provider } = attachmentProvider({
      getMessage: () => Promise.resolve(zipMessage),
      getAttachment: () => Promise.resolve(rawAttachment({ bytes: new Uint8Array(3), size: 3 })),
    });
    const client = await connect(fakeDeps({ createProvider: () => provider }));
    const result = await client.callTool({
      name: 'get_attachment_text',
      arguments: { message_id: '18f3a9c0ffee0001', attachment_id: 'att-1' },
    });
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(textOf(result, 0))).toMatchObject({
      filename: 'all.zip',
      text: '',
      skipped_reason: 'ATTACHMENT_UNSUPPORTED',
      pages: null,
    });
    expect(textOf(result, 1)).toContain('skipped: ATTACHMENT_UNSUPPORTED');
  });

  it('truncates at max_chars and defaults to MAX_ATTACHMENT_CHARS', async () => {
    const { provider } = attachmentProvider();
    const client = await connect(
      fakeDeps({
        config: loadConfig({ MAX_ATTACHMENT_CHARS: '12' }),
        createProvider: () => provider,
      }),
    );
    const byDefault = await client.callTool({
      name: 'get_attachment_text',
      arguments: { message_id: '18f3a9c0ffee0001', attachment_id: 'att-1' },
    });
    const a = JSON.parse(textOf(byDefault, 0)) as AttachmentTextResult;
    expect(a.text).toBe('Quarterly re');
    expect(a.truncated).toBe(true);

    const explicit = await client.callTool({
      name: 'get_attachment_text',
      arguments: { message_id: '18f3a9c0ffee0001', attachment_id: 'att-1', max_chars: 5 },
    });
    expect((JSON.parse(textOf(explicit, 0)) as AttachmentTextResult).text).toBe('Quart');
  });
});

describe('withMailbox (every tool)', () => {
  it('returns AUTH_MISSING_TOKEN from every tool when no token is configured', async () => {
    const checkScope = vi.fn<ScopeCheck>();
    const createProvider = vi.fn(() => fakeProvider());
    const client = await connect(
      fakeDeps({
        resolveCredentials: () => Promise.reject(new MailError('AUTH_MISSING_TOKEN')),
        checkScope,
        createProvider,
      }),
    );

    for (const call of EVERY_TOOL) {
      const result = await client.callTool(call);
      expect(result.isError, call.name).toBe(true);
      expect(JSON.parse(textOf(result, 0))).toMatchObject({ code: 'AUTH_MISSING_TOKEN' });
    }
    expect(checkScope).not.toHaveBeenCalled();
    expect(createProvider).not.toHaveBeenCalled();
  });

  it('returns AUTH_SCOPE_TOO_BROAD from every tool before any provider is built', async () => {
    const checkScope = vi.fn<ScopeCheck>(() =>
      Promise.reject(new MailError('AUTH_SCOPE_TOO_BROAD', 'Token carries gmail.modify.')),
    );
    const createProvider = vi.fn(() => fakeProvider());
    const client = await connect(fakeDeps({ checkScope, createProvider }));

    for (const call of EVERY_TOOL) {
      const result = await client.callTool(call);
      expect(result.isError, call.name).toBe(true);
      expect(JSON.parse(textOf(result, 0))).toMatchObject({
        code: 'AUTH_SCOPE_TOO_BROAD',
        hint: 'Reconnect the mailbox with read-only access only.',
      });
    }
    expect(checkScope).toHaveBeenCalledTimes(EVERY_TOOL.length);
    expect(checkScope).toHaveBeenCalledWith(FAKE_TOKEN);
    expect(createProvider).not.toHaveBeenCalled();
  });

  it('hands the verified scopes to the provider so the profile reports them', async () => {
    const scopes = [READONLY, 'openid'];
    const createProvider = vi.fn((_c, s: readonly string[]) =>
      fakeProvider({ getProfile: () => Promise.resolve({ ...profile, scopes: [...s] }) }),
    );
    const client = await connect(
      fakeDeps({ checkScope: () => Promise.resolve({ scopes }), createProvider }),
    );

    const result = await client.callTool({ name: 'get_mailbox_profile', arguments: {} });

    expect(createProvider.mock.calls[0]?.[1]).toEqual(scopes);
    expect((JSON.parse(textOf(result, 0)) as MailboxProfile).scopes).toEqual(scopes);
  });
});

describe('createDefaultDeps', () => {
  it('wires env config, credentials and the scope check without touching the network', async () => {
    const deps = createDefaultDeps({ MAIL_TOKEN: FAKE_TOKEN, GMAIL_TIMEOUT_MS: '1234' });

    expect(deps.config.limits.gmailTimeoutMs).toBe(1234);
    await expect(deps.resolveCredentials()).resolves.toEqual({
      provider: 'gmail',
      token: FAKE_TOKEN,
    });
    expect(typeof deps.checkScope).toBe('function');
    expect(deps.createProvider({ provider: 'gmail', token: FAKE_TOKEN }, [READONLY]).name).toBe(
      'gmail',
    );
    expect(JSON.stringify(deps.config)).not.toContain(FAKE_TOKEN);
  });
});

// Keep the fixture in play so the recorded profile and the typed profile stay aligned.
it('fake profile matches the recorded Gmail fixture', () => {
  const fixture = JSON.parse(
    readFileSync(new URL('./fixtures/gmail/profile.json', import.meta.url), 'utf8'),
  ) as { emailAddress: string; messagesTotal: number; threadsTotal: number };
  expect(fixture.emailAddress).toBe(profile.email_address);
  expect(fixture.messagesTotal).toBe(profile.messages_total);
  expect(fixture.threadsTotal).toBe(profile.threads_total);
});

// ---------------------------------------------------------------------------
// get_attachment_file
// ---------------------------------------------------------------------------

type ResourceBlock = {
  type: 'resource';
  resource: { uri: string; mimeType?: string; blob?: string };
};

function resourceOf(result: Awaited<ReturnType<Client['callTool']>>): ResourceBlock {
  const block = (result.content as Array<{ type: string }>).find((b) => b.type === 'resource');
  if (!block) throw new Error('no resource block in reply');
  return block as ResourceBlock;
}

describe('get_attachment_file', () => {
  it('returns the metadata block and the original bytes, byte for byte, as a base64 resource', async () => {
    const { provider, getMessage, getAttachment } = attachmentProvider();
    const client = await connect(fakeDeps({ createProvider: () => provider }));

    const result = await client.callTool({
      name: 'get_attachment_file',
      arguments: { message_id: '18f3a9c0ffee0001', filename: 'report.pdf' },
    });

    expect(result.isError).toBeFalsy();
    expect(getMessage).toHaveBeenCalledWith('18f3a9c0ffee0001');
    expect(getAttachment).toHaveBeenCalledWith('18f3a9c0ffee0001', 'att-1');
    expect(JSON.parse(textOf(result, 0))).toEqual({
      attachment_id: 'att-1',
      filename: 'report.pdf',
      mime: 'application/pdf',
      size: samplePdf.byteLength,
    } satisfies AttachmentFileResult);

    const resource = resourceOf(result).resource;
    expect(resource.mimeType).toBe('application/pdf');
    expect(resource.uri).toBe('mail://attachment/18f3a9c0ffee0001/report.pdf');
    const bytes = new Uint8Array(Buffer.from(resource.blob!, 'base64'));
    expect(bytes).toEqual(samplePdf);
    expect(textOf(result, 2)).toContain('report.pdf');
    expect(JSON.stringify(result)).not.toContain('Quarterly report');
  });

  it('resolves a stale attachment_id through the fresh read like get_attachment_text', async () => {
    const { provider, getAttachment } = attachmentProvider();
    const client = await connect(fakeDeps({ createProvider: () => provider }));

    const result = await client.callTool({
      name: 'get_attachment_file',
      arguments: { message_id: '18f3a9c0ffee0001', attachment_id: 'stale-id' },
    });

    expect(result.isError).toBeFalsy();
    expect(getAttachment).toHaveBeenCalledWith('18f3a9c0ffee0001', 'att-1');
  });

  it('refuses an attachment listed over MAX_ATTACHMENT_BYTES without downloading it', async () => {
    const { provider, getAttachment } = attachmentProvider();
    const config = loadConfig({ MAX_ATTACHMENT_BYTES: '500' });
    const client = await connect(fakeDeps({ config, createProvider: () => provider }));

    const result = await client.callTool({
      name: 'get_attachment_file',
      arguments: { message_id: '18f3a9c0ffee0001', filename: 'report.pdf' },
    });

    expect(result.isError).toBe(true);
    expect(JSON.parse(textOf(result, 0))).toMatchObject({
      code: 'ATTACHMENT_UNSUPPORTED',
      message: expect.stringContaining('500 byte limit') as string,
    });
    expect(getAttachment).not.toHaveBeenCalled();
    expect((result.content as Array<{ type: string }>).some((b) => b.type === 'resource')).toBe(
      false,
    );
  });

  it('refuses when the downloaded bytes turn out larger than the listed size allows', async () => {
    const small = rawMessage({
      attachments: [
        { attachment_id: 'att-1', filename: 'report.pdf', mime: 'application/pdf', size: 10 },
      ],
    });
    const { provider } = attachmentProvider({ getMessage: () => Promise.resolve(small) });
    const config = loadConfig({ MAX_ATTACHMENT_BYTES: '500' });
    const client = await connect(fakeDeps({ config, createProvider: () => provider }));

    const result = await client.callTool({
      name: 'get_attachment_file',
      arguments: { message_id: '18f3a9c0ffee0001', filename: 'report.pdf' },
    });

    expect(result.isError).toBe(true);
    expect(JSON.parse(textOf(result, 0))).toMatchObject({ code: 'ATTACHMENT_UNSUPPORTED' });
    expect((result.content as Array<{ type: string }>).some((b) => b.type === 'resource')).toBe(
      false,
    );
  });

  it('is NOT_FOUND when neither attachment_id nor filename is given', async () => {
    const { provider, getMessage } = attachmentProvider();
    const client = await connect(fakeDeps({ createProvider: () => provider }));

    const result = await client.callTool({
      name: 'get_attachment_file',
      arguments: { message_id: '18f3a9c0ffee0001', attachment_id: '', filename: '' },
    });

    expect(result.isError).toBe(true);
    expect(JSON.parse(textOf(result, 0))).toMatchObject({ code: 'NOT_FOUND' });
    expect(getMessage).not.toHaveBeenCalled();
  });

  it('is NOT_FOUND with the filenames when the name does not match', async () => {
    const { provider } = attachmentProvider();
    const client = await connect(fakeDeps({ createProvider: () => provider }));

    const result = await client.callTool({
      name: 'get_attachment_file',
      arguments: { message_id: '18f3a9c0ffee0001', filename: 'missing.pdf' },
    });

    expect(result.isError).toBe(true);
    expect(JSON.parse(textOf(result, 0))).toMatchObject({
      code: 'NOT_FOUND',
      hint: expect.stringContaining('report.pdf') as string,
    });
  });
});

// ---------------------------------------------------------------------------
// collect_mail
// ---------------------------------------------------------------------------

/** ids m01..mNN, newest first as Gmail lists them, served in pages of `pageSize`. */
function collectProvider(
  count: number,
  options: { pageSize?: number; bodyChars?: number; attachments?: boolean } = {},
): {
  provider: MailProvider;
  listMessageIds: ReturnType<typeof vi.fn<MailProvider['listMessageIds']>>;
  getMessage: ReturnType<typeof vi.fn<MailProvider['getMessage']>>;
  getAttachment: ReturnType<typeof vi.fn<MailProvider['getAttachment']>>;
  peak: () => number;
} {
  const pageSize = options.pageSize ?? 500;
  const ids = Array.from({ length: count }, (_, i) => `m${String(i + 1).padStart(2, '0')}`);
  const body = 'x'.repeat(options.bodyChars ?? 100);
  let active = 0;
  let peak = 0;

  const listMessageIds = vi.fn<MailProvider['listMessageIds']>((_filters, page) => {
    const start = page.page_token ? Number(page.page_token) : 0;
    const take = Math.min(page.page_size, pageSize);
    const slice = ids.slice(start, start + take);
    const next = start + take < ids.length ? String(start + take) : null;
    const result: MessageIdPage = {
      query_used: 'subject:(x) -in:spam -in:trash',
      result_size_estimate: ids.length,
      next_page_token: next,
      ids: slice,
    };
    return Promise.resolve(result);
  });

  const getMessage = vi.fn<MailProvider['getMessage']>(async (id) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 1));
    active -= 1;
    return rawMessage({
      message_id: id,
      thread_id: `t-${id}`,
      link: `https://mail.google.com/mail/u/0/#all/${id}`,
      headers: { ...rawMessage().headers, subject: `Subject ${id}` },
      body: { kind: 'text', content: body },
      attachments: options.attachments
        ? [{ attachment_id: `att-${id}`, filename: 'report.pdf', mime: 'application/pdf', size: 1 }]
        : [],
    });
  });

  const getAttachment = vi.fn<MailProvider['getAttachment']>((_m, attachmentId) =>
    Promise.resolve(rawAttachment({ attachment_id: attachmentId })),
  );

  return {
    provider: fakeProvider({ listMessageIds, getMessage, getAttachment }),
    listMessageIds,
    getMessage,
    getAttachment,
    peak: () => peak,
  };
}

function collectResult(result: Awaited<ReturnType<Client['callTool']>>): CollectResult {
  return JSON.parse(textOf(result, 0)) as CollectResult;
}

describe('collect_mail', () => {
  it('stops adding documents at max_total_chars and reports the cut in skipped and stats', async () => {
    const fake = collectProvider(30, { bodyChars: 100 });
    const client = await connect(fakeDeps({ createProvider: () => fake.provider }));

    const result = await client.callTool({
      name: 'collect_mail',
      arguments: { subject: 'x', max_messages: 30, max_total_chars: 1050, attachments: 'none' },
    });

    expect(result.isError).toBeFalsy();
    const body = collectResult(result);
    expect(body.documents).toHaveLength(10);
    expect(body.documents.map((d) => d.reference.message_id)).toEqual([
      'm01',
      'm02',
      'm03',
      'm04',
      'm05',
      'm06',
      'm07',
      'm08',
      'm09',
      'm10',
    ]);
    expect(body.skipped).toHaveLength(20);
    expect(body.skipped[0]).toEqual({ message_id: 'm11', reason: 'MAX_TOTAL_CHARS' });
    expect(body.skipped.every((s) => s.reason === 'MAX_TOTAL_CHARS')).toBe(true);
    expect(body.stats).toEqual({
      messages_found: 30,
      messages_returned: 10,
      attachments_returned: 0,
      total_chars: 1000,
      truncated: true,
    });
    // The cap also stops fetching: far fewer than 30 messages were read.
    expect(fake.getMessage.mock.calls.length).toBeLessThan(30);
    expect(fake.getMessage.mock.calls.length).toBeGreaterThanOrEqual(10);
    expect(textOf(result, 1)).toContain('Collected 10 of about 30');
    expect(textOf(result, 1)).toContain('truncated');
  });

  it('returns every match under the caps with exact counts and truncated: false', async () => {
    const fake = collectProvider(7);
    const client = await connect(fakeDeps({ createProvider: () => fake.provider }));

    const body = collectResult(
      await client.callTool({ name: 'collect_mail', arguments: { subject: 'x' } }),
    );

    expect(body.query_used).toBe('subject:(x) -in:spam -in:trash');
    expect(body.documents).toHaveLength(7);
    expect(body.documents[0]).toMatchObject({
      id: 'gmail:m01',
      kind: 'email',
      headers: { subject: 'Subject m01' },
      text: 'x'.repeat(100),
      attachments: [],
      truncated: false,
    });
    expect(body.documents[0]).not.toHaveProperty('thread_text');
    expect(body.skipped).toEqual([]);
    expect(body.stats).toEqual({
      messages_found: 7,
      messages_returned: 7,
      attachments_returned: 0,
      total_chars: 700,
      truncated: false,
    });
    // Default max_messages (50) asked of the provider; ids only, one page.
    expect(fake.listMessageIds).toHaveBeenCalledTimes(1);
    expect(fake.listMessageIds).toHaveBeenCalledWith({ subject: 'x' }, { page_size: 50 });
  });

  it('pages through ids newest first until max_messages, fetching at most FETCH_CONCURRENCY at once', async () => {
    const fake = collectProvider(40, { pageSize: 8 });
    const client = await connect(fakeDeps({ createProvider: () => fake.provider }));

    const body = collectResult(
      await client.callTool({
        name: 'collect_mail',
        arguments: { subject: 'x', max_messages: 20 },
      }),
    );

    expect(body.documents.map((d) => d.reference.message_id)).toEqual(
      Array.from({ length: 20 }, (_, i) => `m${String(i + 1).padStart(2, '0')}`),
    );
    expect(fake.listMessageIds).toHaveBeenCalledTimes(3);
    expect(fake.listMessageIds.mock.calls[0]?.[1]).toEqual({ page_size: 20 });
    expect(fake.listMessageIds.mock.calls[1]?.[1]).toEqual({ page_size: 12, page_token: '8' });
    expect(fake.getMessage).toHaveBeenCalledTimes(20);
    expect(fake.peak()).toBe(5);
    expect(body.stats).toMatchObject({
      messages_found: 40,
      messages_returned: 20,
      truncated: true,
    });
  });

  it('order oldest_first walks every id, reverses, and takes the earliest max_messages', async () => {
    const fake = collectProvider(12, { pageSize: 5 });
    const client = await connect(fakeDeps({ createProvider: () => fake.provider }));

    const body = collectResult(
      await client.callTool({
        name: 'collect_mail',
        arguments: { subject: 'x', max_messages: 4, order: 'oldest_first' },
      }),
    );

    expect(body.documents.map((d) => d.reference.message_id)).toEqual(['m12', 'm11', 'm10', 'm09']);
    expect(fake.listMessageIds).toHaveBeenCalledTimes(3);
    expect(fake.getMessage).toHaveBeenCalledTimes(4);
    expect(body.stats).toMatchObject({ messages_found: 12, messages_returned: 4, truncated: true });
  });

  it('oldest_first never walks more than MAX_SEARCH_IDS ids', async () => {
    const fake = collectProvider(30, { pageSize: 10 });
    const config = loadConfig({ MAX_SEARCH_IDS: '15' });
    const client = await connect(fakeDeps({ config, createProvider: () => fake.provider }));

    const body = collectResult(
      await client.callTool({
        name: 'collect_mail',
        arguments: { subject: 'x', max_messages: 3, order: 'oldest_first' },
      }),
    );

    expect(fake.listMessageIds).toHaveBeenCalledTimes(2);
    expect(fake.listMessageIds.mock.calls[1]?.[1]).toEqual({ page_size: 5, page_token: '10' });
    expect(body.documents.map((d) => d.reference.message_id)).toEqual(['m15', 'm14', 'm13']);
    expect(body.stats.truncated).toBe(true);
  });

  it('lowers max_messages and max_total_chars to the server caps', async () => {
    const fake = collectProvider(5);
    const config = loadConfig({ MAX_COLLECT_MESSAGES: '2', MAX_TOTAL_CHARS: '150' });
    const client = await connect(fakeDeps({ config, createProvider: () => fake.provider }));

    const body = collectResult(
      await client.callTool({
        name: 'collect_mail',
        arguments: { subject: 'x', max_messages: 999, max_total_chars: 999_999 },
      }),
    );

    expect(fake.listMessageIds.mock.calls[0]?.[1]).toEqual({ page_size: 2 });
    expect(body.documents).toHaveLength(1);
    expect(body.skipped).toEqual([{ message_id: 'm02', reason: 'MAX_TOTAL_CHARS' }]);
  });

  it('extracts attachment text by default and counts it in total_chars', async () => {
    const fake = collectProvider(2, { attachments: true });
    const client = await connect(fakeDeps({ createProvider: () => fake.provider }));

    const body = collectResult(
      await client.callTool({ name: 'collect_mail', arguments: { subject: 'x' } }),
    );

    expect(fake.getAttachment).toHaveBeenCalledTimes(2);
    expect(fake.getAttachment).toHaveBeenCalledWith('m01', 'att-m01');
    const pdfText = body.documents[0]!.attachments[0]!.text;
    expect(pdfText).toBeTruthy();
    expect(body.stats.attachments_returned).toBe(2);
    expect(body.stats.total_chars).toBe(200 + 2 * pdfText!.length);
    expect(body.skipped).toEqual([]);
  });

  it('attachments "list" fetches no bytes; "none" omits them', async () => {
    const listed = collectProvider(1, { attachments: true });
    let client = await connect(fakeDeps({ createProvider: () => listed.provider }));
    let body = collectResult(
      await client.callTool({
        name: 'collect_mail',
        arguments: { subject: 'x', attachments: 'list' },
      }),
    );
    expect(listed.getAttachment).not.toHaveBeenCalled();
    expect(body.documents[0]!.attachments).toEqual([
      {
        attachment_id: 'att-m01',
        filename: 'report.pdf',
        mime: 'application/pdf',
        size: 1,
        text: null,
        truncated: false,
        skipped_reason: null,
      },
    ]);
    expect(body.stats.attachments_returned).toBe(1);

    const none = collectProvider(1, { attachments: true });
    client = await connect(fakeDeps({ createProvider: () => none.provider }));
    body = collectResult(
      await client.callTool({
        name: 'collect_mail',
        arguments: { subject: 'x', attachments: 'none' },
      }),
    );
    expect(none.getAttachment).not.toHaveBeenCalled();
    expect(body.documents[0]!.attachments).toEqual([]);
    expect(body.stats.attachments_returned).toBe(0);
  });

  it('keeps an attachment failure local: text null, listed in skipped with its filename', async () => {
    const fake = collectProvider(2, { attachments: true });
    fake.getAttachment.mockImplementation((messageId, attachmentId) =>
      messageId === 'm01'
        ? Promise.reject(new MailError('NOT_FOUND', 'stale id'))
        : Promise.resolve(rawAttachment({ attachment_id: attachmentId })),
    );
    const client = await connect(fakeDeps({ createProvider: () => fake.provider }));

    const body = collectResult(
      await client.callTool({ name: 'collect_mail', arguments: { subject: 'x' } }),
    );

    expect(body.documents).toHaveLength(2);
    expect(body.documents[0]!.attachments[0]).toMatchObject({
      text: null,
      skipped_reason: 'PARSE_FAILED',
    });
    expect(body.skipped).toEqual([
      { message_id: 'm01', filename: 'report.pdf', reason: 'PARSE_FAILED' },
    ]);
    expect(body.stats.attachments_returned).toBe(1);
  });

  it('a message that fails to fetch is skipped with its error code and the rest come back', async () => {
    const fake = collectProvider(3);
    const healthy = fake.getMessage.getMockImplementation()!;
    fake.getMessage.mockImplementation((id) =>
      id === 'm02' ? Promise.reject(new MailError('NOT_FOUND', 'gone')) : healthy(id),
    );
    const client = await connect(fakeDeps({ createProvider: () => fake.provider }));

    const result = await client.callTool({ name: 'collect_mail', arguments: { subject: 'x' } });

    expect(result.isError).toBeFalsy();
    const body = collectResult(result);
    expect(body.documents.map((d) => d.reference.message_id)).toEqual(['m01', 'm03']);
    expect(body.skipped).toEqual([{ message_id: 'm02', reason: 'NOT_FOUND' }]);
    expect(body.stats).toMatchObject({ messages_found: 3, messages_returned: 2, truncated: false });
    expect(textOf(result, 1)).toContain('1 skipped');
  });

  it('include_thread adds thread_text per document and counts it', async () => {
    const fake = collectProvider(1);
    const getThread = vi.fn<MailProvider['getThread']>(() =>
      Promise.resolve([rawMessage({ body: { kind: 'text', content: 'first' } })]),
    );
    const provider = fakeProvider({ ...fake.provider, getThread });
    const client = await connect(fakeDeps({ createProvider: () => provider }));

    const body = collectResult(
      await client.callTool({
        name: 'collect_mail',
        arguments: { subject: 'x', include_thread: true, attachments: 'none' },
      }),
    );

    expect(getThread).toHaveBeenCalledWith('t-m01');
    const doc = body.documents[0]!;
    expect(doc.thread_text).toContain('first');
    expect(body.stats.total_chars).toBe(doc.text.length + doc.thread_text!.length);
  });

  it('returns QUERY_EMPTY as a structured error when no filter is given', async () => {
    const fake = collectProvider(1);
    fake.listMessageIds.mockImplementation(() =>
      Promise.reject(new MailError('QUERY_EMPTY', 'No search filter was given.')),
    );
    const client = await connect(fakeDeps({ createProvider: () => fake.provider }));

    const result = await client.callTool({ name: 'collect_mail', arguments: {} });

    expect(result.isError).toBe(true);
    expect(JSON.parse(textOf(result, 0))).toMatchObject({ code: 'QUERY_EMPTY' });
    expect(fake.getMessage).not.toHaveBeenCalled();
  });

  it('never leaks the token through a collect reply', async () => {
    const fake = collectProvider(2);
    const client = await connect(fakeDeps({ createProvider: () => fake.provider }));
    const result = await client.callTool({ name: 'collect_mail', arguments: { subject: 'x' } });
    expect(JSON.stringify(result)).not.toContain(FAKE_TOKEN);
  });
});
