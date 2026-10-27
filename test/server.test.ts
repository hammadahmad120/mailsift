import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CredentialResolver } from '../src/auth/credentials.js';
import { MailError } from '../src/errors.js';
import { loadConfig } from '../src/config.js';
import type { MailProvider, MailboxProfile } from '../src/providers/types.js';
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
  it('lists exactly one tool with read-only annotations and an empty input schema', async () => {
    const client = await connect(fakeDeps());

    const { tools } = await client.listTools();

    expect(tools).toHaveLength(1);
    const tool = tools[0]!;
    expect(tool.name).toBe('get_mailbox_profile');
    expect(tool.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: true,
    });
    expect(tool.inputSchema).toMatchObject({ type: 'object' });
    expect(Object.keys(tool.inputSchema.properties ?? {})).toEqual([]);
    expect(JSON.stringify(tools)).not.toContain(FAKE_TOKEN);
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
