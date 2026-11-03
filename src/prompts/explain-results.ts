import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

/**
 * `explain_results` (brief section 12): describe a `collect_mail` reply in
 * plain words. How many were found and returned, what was skipped and why,
 * the query that was used. No arguments: the reply is already in the
 * conversation.
 */
export const EXPLAIN_RESULTS = 'explain_results';

export function renderExplainResults(): string {
  return [
    'Explain the most recent collect_mail reply in plain words for someone who has not seen it. Do not show JSON.',
    '',
    'Cover, in this order:',
    '1. How many messages matched (stats.messages_found) and how many came back (stats.messages_returned). If stats.truncated is true, say a cap kept some out and which cap it looks like.',
    '2. What was skipped (the skipped list): group by reason, give the count per reason, and name a message_id or subject only when it helps the reader act.',
    '3. The query that was used (query_used), in one sentence, so the reader can tell whether it matched their intent.',
    '4. One sentence on what to do next if the result looks wrong: narrow, widen, or ask for a specific attachment.',
    '',
    'Keep it under 150 words. Do not invent numbers; use only what the reply contains.',
  ].join('\n');
}

export function registerExplainResults(server: McpServer): void {
  server.registerPrompt(
    EXPLAIN_RESULTS,
    {
      title: 'Explain collect_mail results',
      description:
        'Describe the last collect_mail reply in plain words: how many, what was skipped and why, the query used.',
    },
    () => ({
      description: 'Plain-words summary of a collect_mail reply',
      messages: [{ role: 'user', content: { type: 'text', text: renderExplainResults() } }],
    }),
  );
}
