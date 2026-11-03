import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createCredentialResolver } from '../src/auth/credentials.js';
import { ConfigError, loadConfig } from '../src/config.js';
import { createLogger } from '../src/logging.js';
import type { MailProvider, MailboxProfile } from '../src/providers/types.js';
import type { ServerDeps } from '../src/server.js';
import { createHttpApp, runHttp } from '../src/transports/http.js';

const SERVER_KEY = 'srv-key-7f3a9c1e-never-in-logs';
const MAIL_TOKEN = 'ya29.http-test-mail-token-never-in-logs';
const ENV_TOKEN = 'ya29.env-token-must-not-be-used-over-http';
const READONLY = 'https://www.googleapis.com/auth/gmail.readonly';

const profile: MailboxProfile = {
  email_address: 'someone@example.com',
  messages_total: 10,
  threads_total: 5,
  provider: 'gmail',
  scopes: [READONLY],
  read_only: true,
};

interface Harness {
  deps: ServerDeps;
  lines: string[];
  records: () => Array<Record<string, unknown>>;
  /** Tokens the fake provider was built with, in call order. */
  tokensSeen: string[];
}

function harness(env: Record<string, string> = {}): Harness {
  const lines: string[] = [];
  const tokensSeen: string[] = [];
  const fullEnv = { MCP_SERVER_KEYS: SERVER_KEY, ...env };
  const provider: MailProvider = {
    name: 'gmail',
    getProfile: () => Promise.resolve(profile),
    search: () => Promise.reject(new Error('not used')),
    listMessageIds: () => Promise.reject(new Error('not used')),
    getMessage: () => Promise.reject(new Error('not used')),
    getThread: () => Promise.reject(new Error('not used')),
    getAttachment: () => Promise.reject(new Error('not used')),
  };
  const deps: ServerDeps = {
    config: loadConfig(fullEnv),
    logger: createLogger({ sink: (line) => lines.push(line), level: 'debug' }),
    resolveCredentials: createCredentialResolver({ env: fullEnv }),
    checkScope: () => Promise.resolve({ scopes: [READONLY] }),
    createProvider: (credentials) => {
      tokensSeen.push(credentials.token);
      return provider;
    },
  };
  return {
    deps,
    lines,
    tokensSeen,
    records: () => lines.map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

async function listen(deps: ServerDeps): Promise<string> {
  const server = await runHttp(deps, { port: 0, host: '127.0.0.1' });
  servers.push(server);
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

type JsonRpc = { jsonrpc: '2.0'; id: number; method: string; params?: Record<string, unknown> };

function rpc(id: number, method: string, params: Record<string, unknown> = {}): JsonRpc {
  return { jsonrpc: '2.0', id, method, params };
}

const initParams = {
  protocolVersion: '2025-06-18',
  capabilities: {},
  clientInfo: { name: 'http-test', version: '0' },
};

async function post(
  base: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...headers,
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const withKey = { authorization: `Bearer ${SERVER_KEY}` };
const withBoth = { ...withKey, 'x-mail-token': MAIL_TOKEN };

interface RpcReply {
  id?: number;
  result?: {
    tools?: Array<{ name: string }>;
    serverInfo?: { name: string };
    content?: Array<{ type: string; text: string }>;
    isError?: boolean;
  };
  error?: { code: number; message: string };
}

describe('createHttpApp', () => {
  it('refuses to build without server keys', () => {
    const h = harness();
    expect(() => createHttpApp({ ...h.deps, config: loadConfig({}) })).toThrow(ConfigError);
    expect(() => createHttpApp({ ...h.deps, config: loadConfig({}) })).toThrow(/MCP_SERVER_KEYS/);
  });
});

describe('GET /healthz', () => {
  it('is open and names the server', async () => {
    const h = harness();
    const base = await listen(h.deps);

    const res = await fetch(`${base}/healthz`);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ status: 'ok', name: 'mailsift', version: '0.1.0' });
    expect(res.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.headers.get('x-powered-by')).toBeNull();
  });
});

describe('POST /mcp server key', () => {
  it('answers 401 with the structured body when the key is missing or wrong', async () => {
    const h = harness();
    const base = await listen(h.deps);

    const missing = await post(base, rpc(1, 'tools/list'));
    expect(missing.status).toBe(401);
    await expect(missing.json()).resolves.toEqual({
      code: 'AUTH_SERVER_KEY',
      message: 'Missing or malformed Authorization header.',
      hint: 'Send a valid server key in the Authorization header.',
    });

    const wrong = await post(base, rpc(1, 'tools/list'), { authorization: 'Bearer nope' });
    expect(wrong.status).toBe(401);
    await expect(wrong.json()).resolves.toMatchObject({ code: 'AUTH_SERVER_KEY' });

    await new Promise((resolve) => setImmediate(resolve));
    const auth = h.records().filter((r) => r['msg'] === 'http auth');
    expect(auth).toHaveLength(2);
    expect(auth[0]).toMatchObject({ level: 'warn', code: 'AUTH_SERVER_KEY' });
    const access = h.records().filter((r) => r['msg'] === 'http');
    expect(access[0]).toMatchObject({ method: 'POST', path: '/mcp', status: 401 });
    expect(h.lines.join('\n')).not.toContain('nope');
  });
});

describe('POST /mcp protocol', () => {
  it('serves initialize and tools/list as plain JSON, stateless', async () => {
    const h = harness();
    const base = await listen(h.deps);

    const init = await post(base, rpc(1, 'initialize', initParams), withKey);
    expect(init.status).toBe(200);
    expect(init.headers.get('content-type')).toContain('application/json');
    expect(init.headers.get('mcp-session-id')).toBeNull();
    const initBody = (await init.json()) as RpcReply;
    expect(initBody.result?.serverInfo).toEqual({ name: 'mailsift', version: '0.1.0' });

    // a brand new request, no session, still works
    const list = await post(base, rpc(2, 'tools/list'), withKey);
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as RpcReply;
    expect(listBody.result?.tools?.map((t) => t.name).sort()).toEqual([
      'collect_mail',
      'get_attachment_file',
      'get_attachment_text',
      'get_email',
      'get_mailbox_profile',
      'search_mail',
    ]);
  });

  it('runs a tool with the mailbox token from X-Mail-Token (end-to-end proof of 5.3)', async () => {
    const h = harness({ MAIL_TOKEN: ENV_TOKEN });
    const base = await listen(h.deps);

    const res = await post(
      base,
      rpc(3, 'tools/call', { name: 'get_mailbox_profile', arguments: {} }),
      withBoth,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as RpcReply;
    expect(body.result?.isError).toBeUndefined();
    const json = JSON.parse(body.result?.content?.[0]?.text ?? '{}') as MailboxProfile;
    expect(json.email_address).toBe('someone@example.com');
    expect(h.tokensSeen).toEqual([MAIL_TOKEN]);
  });

  it('refuses a tool call without X-Mail-Token even when the env has a token (strict by transport)', async () => {
    const h = harness({ MAIL_TOKEN: ENV_TOKEN });
    const base = await listen(h.deps);

    const res = await post(
      base,
      rpc(4, 'tools/call', { name: 'get_mailbox_profile', arguments: {} }),
      withKey,
    );

    expect(res.status).toBe(200); // tool errors are results, not HTTP failures
    const body = (await res.json()) as RpcReply;
    expect(body.result?.isError).toBe(true);
    const err = JSON.parse(body.result?.content?.[0]?.text ?? '{}') as {
      code: string;
      hint: string;
    };
    expect(err.code).toBe('AUTH_MISSING_TOKEN');
    expect(err.hint).toContain('X-Mail-Token');
    expect(h.tokensSeen).toEqual([]);
  });

  it('joins the access line and the tool line by request id, and never logs a secret', async () => {
    const h = harness();
    const base = await listen(h.deps);

    const res = await post(
      base,
      rpc(5, 'tools/call', { name: 'get_mailbox_profile', arguments: {} }),
      withBoth,
    );
    const requestId = res.headers.get('x-request-id');
    await res.json();
    await new Promise((resolve) => setImmediate(resolve)); // let the finish event flush

    const records = h.records();
    const tool = records.find((r) => r['msg'] === 'tool');
    const http = records.find((r) => r['msg'] === 'http');
    expect(tool).toMatchObject({ tool: 'get_mailbox_profile', request_id: requestId, rpc_id: 5 });
    expect(http).toMatchObject({
      method: 'POST',
      path: '/mcp',
      status: 200,
      request_id: requestId,
    });
    expect(typeof http?.['duration_ms']).toBe('number');

    const all = h.lines.join('\n');
    expect(all).not.toContain(MAIL_TOKEN);
    expect(all).not.toContain(SERVER_KEY);
  });

  it('answers 400 to a body that is not JSON and 405 to GET /mcp', async () => {
    const h = harness();
    const base = await listen(h.deps);

    const bad = await post(base, '{not json', withKey);
    expect(bad.status).toBe(400);
    await expect(bad.json()).resolves.toMatchObject({ code: 'PROVIDER_ERROR' });

    const get = await fetch(`${base}/mcp`, { headers: withKey });
    expect(get.status).toBe(405);
    expect(get.headers.get('allow')).toBe('POST');

    const getNoKey = await fetch(`${base}/mcp`);
    expect(getNoKey.status).toBe(401);
  });

  it('answers 404 with a structured body for unknown routes', async () => {
    const h = harness();
    const base = await listen(h.deps);
    const res = await fetch(`${base}/nope`);
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toMatchObject({ code: 'NOT_FOUND' });
  });
});
