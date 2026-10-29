import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { listedAttachments, toDocument } from '../parse/document.js';
import type { DocumentAttachment } from '../providers/types.js';
import type { ServerDeps } from '../server.js';
import { attachmentTexts } from './attachment-texts.js';
import { toolResult } from './result.js';
import { withMailbox } from './with-mailbox.js';

/**
 * `get_email`: one message as a clean Document (brief 8.2): body through the
 * section 11 pipeline, attachments listed, extracted, or omitted.
 */
export const ATTACHMENT_MODES = ['list', 'text', 'none'] as const;
export const getEmailInput = {
  message_id: z.string().min(1).describe('The message_id from a search_mail result.'),
  include_thread: z
    .boolean()
    .optional()
    .describe('true: also return thread_text, every message in the conversation oldest first.'),
  attachments: z
    .enum(ATTACHMENT_MODES)
    .optional()
    .describe(
      '"list" (default): names, types and sizes only. "text": also extract each attachment\'s text (pdf, docx, txt, md, csv, html). "none": omit attachments.',
    ),
  max_chars: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe(
      'Cut the body (and thread_text) at this many characters. Default from server config.',
    ),
  max_attachment_chars: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe('With attachments: "text", cut each attachment at this many characters.'),
};

export function registerGetEmail(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    'get_email',
    {
      title: 'Get email',
      description:
        'Read one message by message_id. Returns a document with headers, the clean body text ' +
        '(quoted replies and signatures removed), the attachments, and a link to the message. ' +
        'Set include_thread to also get the whole conversation as thread_text. ' +
        'Set attachments to "text" to get each attachment\'s extracted text inline. ' +
        `Bodies longer than max_chars (default ${deps.config.limits.maxMessageChars}) are cut and truncated is set.`,
      inputSchema: getEmailInput,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    (args, extra) =>
      withMailbox(deps, extra, async (provider) => {
        const raw = await provider.getMessage(args.message_id);
        const thread = args.include_thread ? await provider.getThread(raw.thread_id) : undefined;

        const mode = args.attachments ?? 'list';
        let attachments: DocumentAttachment[];
        if (mode === 'none') attachments = [];
        else if (mode === 'text') {
          attachments = await attachmentTexts(provider, raw, {
            maxBytes: deps.config.limits.maxAttachmentBytes,
            maxChars: args.max_attachment_chars ?? deps.config.limits.maxAttachmentChars,
            concurrency: deps.config.limits.fetchConcurrency,
          });
        } else attachments = listedAttachments(raw);

        const document = toDocument(raw, {
          source: provider.name,
          maxChars: args.max_chars ?? deps.config.limits.maxMessageChars,
          attachments,
          ...(thread ? { thread } : {}),
        });

        const parts = [
          `"${document.headers.subject || '(no subject)'}" from ${document.headers.from || 'unknown'}`,
          `${document.text.length} chars of body`,
          mode === 'text'
            ? `${document.attachments.filter((a) => a.text !== null).length} of ${document.attachments.length} attachment(s) extracted`
            : `${document.attachments.length} attachment(s) ${mode === 'none' ? 'omitted' : 'listed'}`,
        ];
        if (thread) parts.push(`thread of ${thread.length} message(s)`);
        if (document.truncated) parts.push('truncated');
        return toolResult(document, parts.join(', ') + '.');
      }),
  );
}
