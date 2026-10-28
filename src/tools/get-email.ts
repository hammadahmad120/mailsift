import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { toToolError } from '../errors.js';
import { toDocument } from '../parse/document.js';
import type { ServerDeps } from '../server.js';
import { toolResult } from './result.js';

/**
 * `get_email`: one message as a Document (brief 8.2).
 * Phase 2: raw body, attachments listed only. Phase 3 adds cleaning,
 * the `attachments` mode and `max_attachment_chars`.
 */
export const getEmailInput = {
  message_id: z.string().min(1).describe('The message_id from a search_mail result.'),
  include_thread: z
    .boolean()
    .optional()
    .describe('true: also return thread_text, every message in the conversation oldest first.'),
  max_chars: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe(
      'Cut the body (and thread_text) at this many characters. Default from server config.',
    ),
};

export function registerGetEmail(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    'get_email',
    {
      title: 'Get email',
      description:
        'Read one message by message_id. Returns a document with headers, the body text, ' +
        'the list of attachments, and a link to the message. ' +
        'Set include_thread to also get the whole conversation as thread_text. ' +
        `Bodies longer than max_chars (default ${deps.config.limits.maxMessageChars}) are cut and truncated is set.`,
      inputSchema: getEmailInput,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args, extra) => {
      try {
        const credentials = await deps.resolveCredentials(extra);
        const provider = deps.createProvider(credentials);

        const raw = await provider.getMessage(args.message_id);
        const thread = args.include_thread ? await provider.getThread(raw.thread_id) : undefined;

        const document = toDocument(raw, {
          source: provider.name,
          maxChars: args.max_chars ?? deps.config.limits.maxMessageChars,
          ...(thread ? { thread } : {}),
        });

        const parts = [
          `"${document.headers.subject || '(no subject)'}" from ${document.headers.from || 'unknown'}`,
          `${document.text.length} chars of body`,
          `${document.attachments.length} attachment(s) listed`,
        ];
        if (thread) parts.push(`thread of ${thread.length} message(s)`);
        if (document.truncated) parts.push('truncated');
        return toolResult(document, parts.join(', ') + '.');
      } catch (err) {
        return toToolError(err);
      }
    },
  );
}
