import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { toDocument } from '../parse/document.js';
import { threadToMarkdown } from '../parse/markdown.js';
import type { ServerDeps } from '../server.js';
import { withMailboxOrThrow } from '../tools/with-mailbox.js';
import { templateVariable } from './variables.js';

/**
 * `mail://thread/{thread_id}`: a whole conversation as one markdown page
 * (brief section 12), oldest message first, each with its headers, clean body
 * and attachment list. One provider read. Each message body is capped at the
 * server's `MAX_MESSAGE_CHARS`, the same cap `get_email` applies. No `list` callback.
 */
export const THREAD_URI_TEMPLATE = 'mail://thread/{thread_id}';

export function registerThreadResource(server: McpServer, deps: ServerDeps): void {
  server.registerResource(
    'thread',
    new ResourceTemplate(THREAD_URI_TEMPLATE, { list: undefined }),
    {
      title: 'Thread',
      description:
        'A whole conversation as markdown: every message in the thread, oldest first, each with headers, ' +
        'clean body text and attachment list. Use a thread_id from a search_mail or get_email result.',
      mimeType: 'text/markdown',
    },
    (uri, variables, extra) =>
      withMailboxOrThrow(deps, 'resource:thread', extra, async (provider) => {
        const threadId = templateVariable(variables, 'thread_id');
        const messages = await provider.getThread(threadId);
        const documents = messages.map((raw) =>
          toDocument(raw, { source: provider.name, maxChars: deps.config.limits.maxMessageChars }),
        );
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: 'text/markdown',
              text: threadToMarkdown(threadId, documents),
            },
          ],
        };
      }),
  );
}
