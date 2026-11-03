# Drive mailsift from your own backend

This is the loop a service runs when it wants a model to collect mail for a brief: connect to mailsift over HTTP, fetch the tools and the `collect_for_brief` prompt, hand both to the model, let it search and collect, keep the documents.

The model side uses the Vercel AI SDK (`ai` 5 or newer, any provider package). The MCP side uses the official `@modelcontextprotocol/sdk` client directly, so the snippet does not depend on which MCP helper the AI SDK ships this month.

```
npm install ai @ai-sdk/google @modelcontextprotocol/sdk
```

## The loop

```ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { google } from '@ai-sdk/google';
import { generateText, jsonSchema, stepCountIs, tool } from 'ai';

const MAILSIFT_URL = process.env.MAILSIFT_URL ?? 'http://localhost:3000/mcp';
const SERVER_KEY = process.env.MAILSIFT_SERVER_KEY!; // one of the server's MCP_SERVER_KEYS

export async function collectForBrief(brief: string, mailToken: string) {
  // 1. One MCP client per job. Both credentials ride on every request.
  const client = new Client({ name: 'my-backend', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(MAILSIFT_URL), {
    requestInit: {
      headers: {
        Authorization: `Bearer ${SERVER_KEY}`,
        'X-Mail-Token': mailToken,
      },
    },
  });
  await client.connect(transport);

  try {
    // 2. The server's tools, wrapped so the AI SDK can call them.
    const { tools: listed } = await client.listTools();
    const tools = Object.fromEntries(
      listed.map((t) => [
        t.name,
        tool({
          description: t.description ?? '',
          inputSchema: jsonSchema(t.inputSchema as Parameters<typeof jsonSchema>[0]),
          execute: async (args) => {
            const result = await client.callTool({
              name: t.name,
              arguments: args as Record<string, unknown>,
            });
            // mailsift replies with a JSON text block first, then a one-line summary. Give the model the JSON.
            const first = (result.content as Array<{ type: string; text?: string }>)[0];
            return first?.type === 'text' && first.text
              ? first.text
              : JSON.stringify(result.content);
          },
        }),
      ]),
    );

    // 3. The workflow prompt, with the brief filled in, straight from the server.
    const prompt = await client.getPrompt({ name: 'collect_for_brief', arguments: { brief } });
    const instructions = prompt.messages
      .map((m) => (m.content.type === 'text' ? m.content.text : ''))
      .join('\n');

    // 4. Let the model search, refine, collect, stop. The step cap is the safety net.
    const run = await generateText({
      model: google('gemini-2.5-pro'),
      tools,
      prompt: instructions,
      stopWhen: stepCountIs(8),
    });

    // 5. Pull the collect_mail reply out of the run. That is the product.
    for (const step of run.steps) {
      for (const call of step.toolResults) {
        if (call.toolName === 'collect_mail') {
          return JSON.parse(call.output as string) as CollectReply;
        }
      }
    }
    // No collect call: the model gave up after two refinements and asked a question.
    return { question: run.text };
  } finally {
    await client.close();
  }
}

interface CollectReply {
  query_used: string;
  documents: unknown[];
  skipped: Array<{ message_id: string; filename?: string; reason: string }>;
  stats: { messages_found: number; messages_returned: number; truncated: boolean };
}
```

## Where the mail token comes from

Your app holds each user's Google refresh token, obtained once through your own OAuth consent screen with the `gmail.readonly` scope only. Before each job, exchange it for an access token and pass that as `mailToken`. Cache the access token in memory for about 55 minutes; Google's last an hour. mailsift never sees the refresh token.

```ts
async function accessTokenFor(refreshToken: string): Promise<string> {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: process.env.GOOGLE_CLIENT_ID!,
      client_secret: process.env.GOOGLE_CLIENT_SECRET!,
    }),
  });
  if (!res.ok) throw new Error(`token refresh failed: ${res.status}`);
  const { access_token } = (await res.json()) as { access_token: string };
  return access_token;
}
```

## What the run looks like

With `LOG_LEVEL=debug` on the server you see one line per request and one per tool call, all carrying the same `request_id`. A typical job is four to six tool calls:

1. `search_mail` with the first guess at filters.
2. Sometimes a second or third `search_mail` after narrowing or widening.
3. `collect_mail` with the final filters.
4. The model's closing text.

If the model never calls `collect_mail`, the prompt told it to stop and ask one question. `run.text` holds that question; show it to the user and run again with a better brief or `hints`.

## Things that go wrong

| Symptom                                         | Cause                                                        | Fix                                                                  |
| ----------------------------------------------- | ------------------------------------------------------------ | -------------------------------------------------------------------- |
| 401 on connect                                  | Wrong or missing server key                                  | Check `MCP_SERVER_KEYS` on the server and the `Authorization` header |
| Every tool answers `AUTH_MISSING_TOKEN`         | `X-Mail-Token` header missing                                | Pass it in `requestInit.headers`                                     |
| Every tool answers `AUTH_SCOPE_TOO_BROAD`       | The refresh token was issued with more than `gmail.readonly` | Re-consent with the read-only scope only                             |
| `AUTH_TOKEN_INVALID` part way through a job     | Access token expired                                         | Re-mint before each job, cache under an hour                         |
| Run ends at the step cap with no `collect_mail` | The model kept refining                                      | Give better `hints`, or raise `stepCountIs` a little                 |
| `stats.truncated: true`                         | A cap cut the result                                         | Narrow the filters, or raise `max_messages` up to the server's cap   |
