import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { toDocument } from '../parse/document.js';
import { documentToMarkdown } from '../parse/markdown.js';
import type { ServerDeps } from '../server.js';
import { withMailboxOrThrow } from '../tools/with-mailbox.js';
import { templateVariable } from './variables.js';

/**
 * `mail://message/{message_id}`: one message as a markdown document (brief section 12).
 * A client can "open" an email by URI and hand the model readable text without a
 * tool call. One provider read; attachments are listed, not extracted (the tools
 * do that on request). Same body cap as `get_email`'s default. No `list`
 * callback: enumerating a mailbox is `search_mail`'s job.
 */
export const MESSAGE_URI_TEMPLATE = 'mail://message/{message_id}';

export function registerMessageResource(server: McpServer, deps: ServerDeps): void {
  server.registerResource(
    'message',
    new ResourceTemplate(MESSAGE_URI_TEMPLATE, { list: undefined }),
    {
      title: 'Message',
      description:
        'One email as markdown: subject, headers, the clean body text (quoted replies and signatures removed), ' +
        'and the attachment list. Use a message_id from a search_mail result. ' +
        'Same content as the get_email tool, rendered for reading.',
      mimeType: 'text/markdown',
    },
    (uri, variables, extra) =>
      withMailboxOrThrow(deps, 'resource:message', extra, async (provider) => {
        const messageId = templateVariable(variables, 'message_id');
        const raw = await provider.getMessage(messageId);
        const document = toDocument(raw, {
          source: provider.name,
          maxChars: deps.config.limits.maxMessageChars,
        });
        return {
          contents: [
            { uri: uri.href, mimeType: 'text/markdown', text: documentToMarkdown(document) },
          ],
        };
      }),
  );
}
