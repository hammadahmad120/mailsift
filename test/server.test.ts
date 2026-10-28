import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CredentialResolver } from '../src/auth/credentials.js';
import { MailError } from '../src/errors.js';
import { loadConfig } from '../src/config.js';
import type { MailProvider, MailboxProfile, SearchResult } from '../src/providers/types.js';
import { createDefaultDeps, createServer, type ServerDeps } from '../src/server.js';

const FAKE_TOKEN = 'ya29.test-token-must-never-leak';

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

    expect(tools.map((t) => t.name).sort()).toEqual(['get_mailbox_profile', 'search_mail']);
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
    expect(createProvider).toHaveBeenCalledWith({ provider: 'gmail', token: FAKE_TOKEN });
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

describe('createDefaultDeps', () => {
  it('wires env config and credentials without touching the network', async () => {
    const deps = createDefaultDeps({ MAIL_TOKEN: FAKE_TOKEN, GMAIL_TIMEOUT_MS: '1234' });

    expect(deps.config.limits.gmailTimeoutMs).toBe(1234);
    await expect(deps.resolveCredentials()).resolves.toEqual({
      provider: 'gmail',
      token: FAKE_TOKEN,
    });
    expect(deps.createProvider({ provider: 'gmail', token: FAKE_TOKEN }).name).toBe('gmail');
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
