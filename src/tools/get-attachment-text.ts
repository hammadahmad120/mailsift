import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { MailError } from '../errors.js';
import { parseAttachment } from '../parse/attachments/index.js';
import { truncate } from '../parse/document.js';
import type {
  AttachmentMeta,
  AttachmentSkipReason,
  MailProvider,
  RawAttachment,
} from '../providers/types.js';
import type { ServerDeps } from '../server.js';
import { optionalText, present } from './args.js';
import { toolResult } from './result.js';
import { withMailbox } from './with-mailbox.js';

/**
 * `get_attachment_text`: one attachment as text (brief 8.3).
 * Looked up by attachment_id, or by filename, or by id with a filename
 * fallback when the id turns out stale (Gmail ids are not stable).
 */
export const getAttachmentTextInput = {
  message_id: z.string().min(1).describe('The message_id the attachment belongs to.'),
  attachment_id: optionalText('attachment_id from a search_mail or get_email result.'),
  filename: optionalText(
    'Attachment filename, case-insensitive. Preferred: attachment ids change between reads.',
  ),
  max_chars: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe('Cut the text at this many characters. Default from server config.'),
};

export interface AttachmentTextResult {
  attachment_id: string;
  filename: string;
  mime: string;
  size: number;
  text: string;
  truncated: boolean;
  pages: number | null;
  skipped_reason: AttachmentSkipReason | null;
}

/**
 * Pick the attachment from a fresh read of the message: by the id the caller
 * has (valid only if issued by a very recent read), else by filename, else the
 * only attachment when there is exactly one. Gmail attachment ids change on
 * every read, so the bytes are always fetched with the id from this read.
 */
export async function resolveAttachment(
  provider: MailProvider,
  messageId: string,
  attachmentId: string | undefined,
  filename: string | undefined,
): Promise<{ meta: AttachmentMeta; raw: RawAttachment }> {
  const message = await provider.getMessage(messageId);
  const list = message.attachments;
  const wanted = filename?.trim().toLowerCase();

  const meta =
    (attachmentId !== undefined ? list.find((a) => a.attachment_id === attachmentId) : undefined) ??
    (wanted !== undefined ? list.find((a) => a.filename.toLowerCase() === wanted) : undefined) ??
    (filename === undefined && list.length === 1 ? list[0] : undefined);

  if (!meta) {
    const names = list.map((a) => a.filename).join(', ') || 'none';
    throw new MailError(
      'NOT_FOUND',
      filename !== undefined
        ? `No attachment named "${filename}" on message ${messageId}.`
        : `Attachment id not found on message ${messageId}; ids change between reads.`,
      `Pass filename instead. Attachments on this message: ${names}.`,
    );
  }

  const raw = await provider.getAttachment(messageId, meta.attachment_id);
  return { meta, raw };
}

export function registerGetAttachmentText(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    'get_attachment_text',
    {
      title: 'Get attachment text',
      description:
        'Extract the text of one attachment (pdf, docx, txt, md, csv, html) by attachment_id or filename. ' +
        'Attachment ids change between reads, so pass the filename whenever you have it; a stale id falls back to the filename, or to the only attachment when there is just one. ' +
        'Unsupported, oversized or unreadable files return empty text with a skipped_reason instead of an error. ' +
        `Text longer than max_chars (default ${deps.config.limits.maxAttachmentChars}) is cut and truncated is set.`,
      inputSchema: getAttachmentTextInput,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    (args, extra) =>
      withMailbox(deps, extra, async (provider) => {
        const attachmentId = present(args.attachment_id);
        const filename = present(args.filename);
        if (attachmentId === undefined && filename === undefined) {
          throw new MailError(
            'NOT_FOUND',
            'Neither attachment_id nor filename was given.',
            'Pass the attachment_id or the filename from the message attachments list.',
          );
        }

        const { meta, raw } = await resolveAttachment(
          provider,
          args.message_id,
          attachmentId,
          filename,
        );
        const parsed = await parseAttachment(
          { mime: meta.mime, filename: meta.filename, bytes: raw.bytes },
          { maxBytes: deps.config.limits.maxAttachmentBytes },
        );
        const cut = truncate(parsed.text, args.max_chars ?? deps.config.limits.maxAttachmentChars);

        const result: AttachmentTextResult = {
          attachment_id: raw.attachment_id,
          filename: meta.filename,
          mime: meta.mime,
          size: raw.size,
          text: cut.text,
          truncated: cut.truncated,
          pages: parsed.pages,
          skipped_reason: parsed.skipped_reason,
        };

        const summary = parsed.skipped_reason
          ? `${meta.filename} (${meta.mime}, ${raw.size} bytes) skipped: ${parsed.skipped_reason}.`
          : `${meta.filename} (${meta.mime}, ${raw.size} bytes): ${cut.text.length} chars` +
            (parsed.pages !== null ? `, ${parsed.pages} page(s)` : '') +
            (cut.truncated ? ', truncated.' : '.');
        return toolResult(result, summary);
      }),
  );
}
