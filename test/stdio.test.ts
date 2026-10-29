import { PassThrough } from 'node:stream';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it } from 'vitest';
import { main } from '../src/index.js';

const FAKE_TOKEN = 'ya29.stdio-test-token';

interface JsonRpcReply {
  id?: number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

/** Drive the real stdio transport through in-memory streams, one JSON-RPC line at a time. */
function stdioHarness() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const logs: string[] = [];

  let buffered = '';
  const pending: Array<(reply: JsonRpcReply) => void> = [];
  stdout.on('data', (chunk: Buffer) => {
    buffered += chunk.toString('utf8');
    let newline = buffered.indexOf('\n');
    while (newline !== -1) {
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      pending.shift()?.(JSON.parse(line) as JsonRpcReply);
      newline = buffered.indexOf('\n');
    }
  });

  const send = (message: Record<string, unknown>): void => {
    stdin.write(JSON.stringify(message) + '\n');
  };
  const request = (id: number, method: string, params: Record<string, unknown> = {}) =>
    new Promise<JsonRpcReply>((resolve) => {
      pending.push(resolve);
      send({ jsonrpc: '2.0', id, method, params });
    });

  return { stdin, stdout, logs, send, request, log: (line: string) => logs.push(line) };
}

describe('main --stdio', () => {
  it('serves the tool list over newline-delimited JSON-RPC on stdout', async () => {
    const h = stdioHarness();

    const code = await main([], {
      env: { MAIL_TOKEN: FAKE_TOKEN },
      streams: { stdin: h.stdin, stdout: h.stdout },
      log: h.log,
    });
    expect(code).toBe(0);
    expect(h.logs).toEqual(['[mailsift] stdio server ready']);

    const init = await h.request(1, 'initialize', {
      protocolVersion: LATEST_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'test', version: '0' },
    });
    expect(init.result).toMatchObject({ serverInfo: { name: 'mailsift' } });
    h.send({ jsonrpc: '2.0', method: 'notifications/initialized' });

    const list = await h.request(2, 'tools/list');
    const tools = list.result?.['tools'] as Array<{ name: string }>;
    expect(tools.map((t) => t.name).sort()).toEqual([
      'collect_mail',
      'get_attachment_file',
      'get_attachment_text',
      'get_email',
      'get_mailbox_profile',
      'search_mail',
    ]);

    expect(JSON.stringify(h.logs)).not.toContain(FAKE_TOKEN);
    h.stdin.end();
  });

  it('fails fast with a clear message on a bad environment', async () => {
    const h = stdioHarness();

    const code = await main([], {
      env: { MAIL_TOKEN: FAKE_TOKEN, MAX_PAGE_SIZE: 'abc' },
      streams: { stdin: h.stdin, stdout: h.stdout },
      log: h.log,
    });

    expect(code).toBe(1);
    expect(h.logs[0]).toContain('MAX_PAGE_SIZE');
    expect(JSON.stringify(h.logs)).not.toContain(FAKE_TOKEN);
  });

  it('starts without a token; the error surfaces per tool call, not at boot', async () => {
    const h = stdioHarness();
    const code = await main([], { env: {}, streams: h, log: h.log });
    expect(code).toBe(0);
    h.stdin.end();
  });
});

describe('main --http', () => {
  it('exits with code 1 and a not-yet message', async () => {
    const logs: string[] = [];
    const code = await main(['--http'], { env: {}, log: (l) => logs.push(l) });
    expect(code).toBe(1);
    expect(logs[0]).toContain('--http is not implemented yet');
  });
});
