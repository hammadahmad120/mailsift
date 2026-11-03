import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpError } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { silentLogger } from '../src/logging.js';
import { BUILD_MAIL_QUERY, renderBuildMailQuery } from '../src/prompts/build-mail-query.js';
import {
  COLLECT_FOR_BRIEF,
  MAX_REFINEMENTS,
  MIN_USEFUL_RESULTS,
  renderCollectForBrief,
} from '../src/prompts/collect-for-brief.js';
import { EXPLAIN_RESULTS, renderExplainResults } from '../src/prompts/explain-results.js';
import { SEARCH_SYNTAX_URI } from '../src/resources/search-syntax.js';
import { createServer, type ServerDeps } from '../src/server.js';

function fakeDeps(overrides: Partial<ServerDeps> = {}): ServerDeps {
  const notCalled = () => Promise.reject(new Error('prompts must not touch the mailbox'));
  return {
    config: loadConfig({}),
    resolveCredentials: notCalled,
    checkScope: notCalled,
    createProvider: () => {
      throw new Error('prompts must not touch the mailbox');
    },
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

function textOf(result: { messages: Array<{ content: { type: string; text?: string } }> }): string {
  expect(result.messages).toHaveLength(1);
  expect(result.messages[0]?.content.type).toBe('text');
  return result.messages[0]?.content.text ?? '';
}

/** Words that must never appear in server text (CLAUDE.md naming rule). */
const FORBIDDEN = /\b(resume|candidate|job|complaint|invoice)s?\b/i;

describe('prompts/list', () => {
  it('lists the three prompts with their arguments and required flags', async () => {
    const client = await connect(fakeDeps());
    const { prompts } = await client.listPrompts();

    expect(prompts.map((p) => p.name).sort()).toEqual(
      [BUILD_MAIL_QUERY, COLLECT_FOR_BRIEF, EXPLAIN_RESULTS].sort(),
    );

    const build = prompts.find((p) => p.name === BUILD_MAIL_QUERY);
    expect(build?.title).toBe('Build a mail query');
    expect(build?.arguments?.map((a) => [a.name, a.required ?? false])).toEqual([
      ['request', true],
      ['today', true],
      ['default_window_days', true],
    ]);

    const collect = prompts.find((p) => p.name === COLLECT_FOR_BRIEF);
    expect(collect?.arguments?.map((a) => [a.name, a.required ?? false])).toEqual([
      ['brief', true],
      ['hints', false],
    ]);

    const explain = prompts.find((p) => p.name === EXPLAIN_RESULTS);
    expect(explain?.arguments ?? []).toEqual([]);
  });
});

describe(BUILD_MAIL_QUERY, () => {
  it('substitutes the arguments and states the configured range cap', async () => {
    const client = await connect(fakeDeps({ config: loadConfig({ MAX_RANGE_DAYS: '45' }) }));

    const result = await client.getPrompt({
      name: BUILD_MAIL_QUERY,
      arguments: {
        request: 'statements from the bank since March',
        today: '2026-11-03',
        default_window_days: '30',
      },
    });
    const text = textOf(result);

    expect(result.messages[0]?.role).toBe('user');
    expect(text).toContain('Request: statements from the bank since March');
    expect(text).toContain('Today: 2026-11-03');
    expect(text).toContain('Default window: 30 days');
    expect(text).toContain('at most 45 days');
    expect(text).toContain(SEARCH_SYNTAX_URI);
    expect(text).toContain('Never invent a sender');
    expect(text).toContain('what is missing');
  });

  it('rejects a missing or malformed required argument as a JSON-RPC error', async () => {
    const client = await connect(fakeDeps());

    const missing = await client
      .getPrompt({ name: BUILD_MAIL_QUERY, arguments: { request: 'x' } })
      .catch((e: unknown) => e);
    expect(missing).toBeInstanceOf(McpError);

    const badDate = await client
      .getPrompt({
        name: BUILD_MAIL_QUERY,
        arguments: { request: 'x', today: '3 Nov', default_window_days: '30' },
      })
      .catch((e: unknown) => e);
    expect(badDate).toBeInstanceOf(McpError);
    expect((badDate as McpError).message).toContain('YYYY-MM-DD');
  });

  it('render lists every search filter field', () => {
    const text = renderBuildMailQuery(
      { request: 'r', today: '2026-01-01', default_window_days: '7' },
      365,
    );
    for (const field of [
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
    ]) {
      expect(text).toContain(field);
    }
  });
});

describe(COLLECT_FOR_BRIEF, () => {
  it("embeds the brief and hints and this deployment's caps", async () => {
    const client = await connect(
      fakeDeps({ config: loadConfig({ MAX_COLLECT_MESSAGES: '120', MAX_RANGE_DAYS: '60' }) }),
    );

    const result = await client.getPrompt({
      name: COLLECT_FOR_BRIEF,
      arguments: { brief: 'weekly reports from the team', hints: 'subject "weekly", last quarter' },
    });
    const text = textOf(result);

    expect(text).toContain('Brief: weekly reports from the team');
    expect(text).toContain('Hints: subject "weekly", last quarter');
    expect(text).toContain(`at most ${MAX_REFINEMENTS} times`);
    expect(text).toContain('over 120');
    expect(text).toContain(`under ${MIN_USEFUL_RESULTS}`);
    expect(text).toContain('at most 60 days');
    expect(text).toContain('collect_mail once');
    expect(text).toContain('ask one question');
    expect(text).toContain(SEARCH_SYNTAX_URI);
  });

  it('works without hints and reads "none"', async () => {
    const client = await connect(fakeDeps());
    const result = await client.getPrompt({ name: COLLECT_FOR_BRIEF, arguments: { brief: 'b' } });
    expect(textOf(result)).toContain('Hints: none');

    const blank = renderCollectForBrief(
      { brief: 'b', hints: '   ' },
      { maxCollectMessages: 1, maxRangeDays: 1 },
    );
    expect(blank).toContain('Hints: none');
  });

  it('requires brief', async () => {
    const client = await connect(fakeDeps());
    const err = await client
      .getPrompt({ name: COLLECT_FOR_BRIEF, arguments: {} })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(McpError);
  });
});

describe(EXPLAIN_RESULTS, () => {
  it('takes no arguments and names the fields of a collect_mail reply', async () => {
    const client = await connect(fakeDeps());
    const result = await client.getPrompt({ name: EXPLAIN_RESULTS });
    const text = textOf(result);

    expect(text).toBe(renderExplainResults());
    for (const field of [
      'messages_found',
      'messages_returned',
      'truncated',
      'skipped',
      'query_used',
    ]) {
      expect(text).toContain(field);
    }
    expect(text).toContain('Do not invent numbers');
  });
});

describe('wording', () => {
  it('uses generic mail words only', () => {
    const texts = [
      renderBuildMailQuery({ request: 'r', today: '2026-01-01', default_window_days: '7' }, 10),
      renderCollectForBrief({ brief: 'b' }, { maxCollectMessages: 10, maxRangeDays: 10 }),
      renderExplainResults(),
    ];
    for (const t of texts) expect(t).not.toMatch(FORBIDDEN);
  });

  it('never touches the mailbox', async () => {
    const client = await connect(fakeDeps());
    await expect(client.getPrompt({ name: EXPLAIN_RESULTS })).resolves.toBeDefined();
    await expect(
      client.getPrompt({ name: COLLECT_FOR_BRIEF, arguments: { brief: 'b' } }),
    ).resolves.toBeDefined();
  });
});
