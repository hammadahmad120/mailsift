import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpError } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it } from 'vitest';
import { MailError, toMcpError } from '../src/errors.js';
import { loadConfig } from '../src/config.js';
import { silentLogger } from '../src/logging.js';
import type { MailProvider, MailboxProfile, SearchFilters } from '../src/providers/types.js';
import { PROFILE_URI } from '../src/resources/profile.js';
import {
  EXAMPLES,
  FIELD_DOCS,
  SEARCH_SYNTAX_URI,
  renderSearchSyntax,
} from '../src/resources/search-syntax.js';
import { createServer, type ServerDeps } from '../src/server.js';

const FAKE_TOKEN = 'ya29.resource-test-token';
const READONLY = 'https://www.googleapis.com/auth/gmail.readonly';

const profile: MailboxProfile = {
  email_address: 'someone@example.com',
  messages_total: 12,
  threads_total: 9,
  provider: 'gmail',
  scopes: [READONLY],
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
    logger: silentLogger(),
    ...overrides,
  };
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

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

describe('resources/list', () => {
  it('lists the two static resources with names, titles and mime types', async () => {
    const client = await connect(fakeDeps());
    const { resources } = await client.listResources();

    expect(resources.map((r) => r.uri).sort()).toEqual([PROFILE_URI, SEARCH_SYNTAX_URI]);
    expect(resources.find((r) => r.uri === PROFILE_URI)).toMatchObject({
      name: 'profile',
      title: 'Mailbox profile',
      mimeType: 'application/json',
    });
    expect(resources.find((r) => r.uri === SEARCH_SYNTAX_URI)).toMatchObject({
      name: 'search-syntax',
      title: 'Search syntax',
      mimeType: 'text/markdown',
    });
  });
});

describe('mail://profile', () => {
  it('returns the same JSON as the tool, through the credential and scope path', async () => {
    let scopeChecked = false;
    const client = await connect(
      fakeDeps({
        checkScope: () => {
          scopeChecked = true;
          return Promise.resolve({ scopes: [READONLY] });
        },
      }),
    );

    const { contents } = await client.readResource({ uri: PROFILE_URI });

    expect(contents).toHaveLength(1);
    expect(contents[0]).toMatchObject({ uri: PROFILE_URI, mimeType: 'application/json' });
    expect(JSON.parse((contents[0] as { text: string }).text)).toEqual(profile);
    expect(scopeChecked).toBe(true);
  });

  it('fails as a JSON-RPC error carrying the structured body when no token is configured', async () => {
    const client = await connect(
      fakeDeps({
        resolveCredentials: () => Promise.reject(new MailError('AUTH_MISSING_TOKEN')),
      }),
    );

    const err = await client.readResource({ uri: PROFILE_URI }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(McpError);
    expect((err as McpError).message).toContain('AUTH_MISSING_TOKEN');
    expect((err as McpError).data).toMatchObject({ code: 'AUTH_MISSING_TOKEN' });
    expect(JSON.stringify(err)).not.toContain(FAKE_TOKEN);
  });

  it('hides provider internals behind PROVIDER_ERROR', async () => {
    const client = await connect(
      fakeDeps({
        createProvider: () =>
          fakeProvider({ getProfile: () => Promise.reject(new TypeError('internal detail')) }),
      }),
    );

    const err = (await client
      .readResource({ uri: PROFILE_URI })
      .catch((e: unknown) => e)) as McpError;

    expect(err.data).toMatchObject({ code: 'PROVIDER_ERROR' });
    expect(err.message).not.toContain('internal detail');
  });
});

describe('mail://search-syntax', () => {
  it('serves markdown that names every filter field, the rules and six examples', async () => {
    const client = await connect(fakeDeps({ config: loadConfig({ MAX_RANGE_DAYS: '90' }) }));

    const { contents } = await client.readResource({ uri: SEARCH_SYNTAX_URI });
    const text = (contents[0] as { text: string }).text;

    expect(contents[0]).toMatchObject({ uri: SEARCH_SYNTAX_URI, mimeType: 'text/markdown' });
    const fields: Array<keyof SearchFilters> = [
      'subject',
      'from',
      'to',
      'keywords',
      'any_keywords',
      'after',
      'before',
      'has_attachment',
      'attachment_types',
      'label',
      'raw_query',
    ];
    for (const field of fields) expect(text).toContain(`\`${field}\``);
    expect(text).toContain('at most 90 days');
    expect(text).toContain('-in:spam -in:trash');
    expect(text).toContain('QUERY_EMPTY');
    expect(text).toContain('RANGE_TOO_WIDE');
    expect(text.match(/^### \d\. /gm)).toHaveLength(6);
  });

  it('needs no credentials', async () => {
    const client = await connect(
      fakeDeps({ resolveCredentials: () => Promise.reject(new Error('must not be called')) }),
    );
    await expect(client.readResource({ uri: SEARCH_SYNTAX_URI })).resolves.toBeDefined();
  });
});

describe('renderSearchSyntax', () => {
  it('documents exactly the SearchFilters fields, once each', () => {
    const documented = FIELD_DOCS.map((f) => f.field);
    expect(new Set(documented).size).toBe(documented.length);
    expect(documented.length).toBe(11);
  });

  it('derives every example query from buildQuery so they cannot drift', () => {
    const text = renderSearchSyntax({ maxRangeDays: 365, now: new Date('2026-11-03T00:00:00Z') });

    expect(EXAMPLES).toHaveLength(6);
    expect(text).toContain(
      'Gmail query: `subject:(statement) from:(billing@example.com) -in:spam -in:trash`',
    );
    expect(text).toContain('{quote quotation estimate}');
    expect(text).toContain('after:2026/01/01 before:2026/04/01');
    expect(text).toContain('filename:pdf');
    expect(text).toContain('label:Project-Alpha');
    expect(text).toContain('larger:5M is:unread');
    expect(text).toContain('-has:attachment');
    expect(text).toContain('subject:(weekly report)');
  });

  it('is deterministic for a fixed clock', () => {
    const a = renderSearchSyntax({ maxRangeDays: 30 });
    const b = renderSearchSyntax({ maxRangeDays: 30 });
    expect(a).toBe(b);
    expect(a.endsWith('\n')).toBe(true);
  });
});

describe('toMcpError', () => {
  it('maps NOT_FOUND to invalid params and everything else to internal error, keeping the body', () => {
    const notFound = toMcpError(new MailError('NOT_FOUND', 'gone'));
    expect(notFound.code).toBe(-32602);
    expect(notFound.data).toEqual({
      code: 'NOT_FOUND',
      message: 'gone',
      hint: 'Check the id and retry, or search again to get a fresh id.',
    });

    const rate = toMcpError(new MailError('RATE_LIMITED'));
    expect(rate.code).toBe(-32603);

    const unknown = toMcpError(new Error(`leak ${FAKE_TOKEN}`));
    expect(unknown.data).toMatchObject({ code: 'PROVIDER_ERROR' });
    expect(JSON.stringify(unknown)).not.toContain(FAKE_TOKEN);

    const passthrough = toMcpError(notFound);
    expect(passthrough).toBe(notFound);
  });
});
