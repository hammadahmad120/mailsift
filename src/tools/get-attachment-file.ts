import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { MailError } from '../errors.js';
import type { ServerDeps } from '../server.js';
import { optionalText } from './args.js';
import { attachmentRef, findAttachment } from './get-attachment-text.js';
import { withMailbox } from './with-mailbox.js';

/**
 * `get_attachment_file`: one attachment's original bytes (brief 8.6). Same
 * lookup as `get_attachment_text`, no parsing. The reply is the usual JSON
 * block plus an MCP embedded resource carrying the file as base64 with its
 * mime type, which is how MCP moves binary content.
 */
export const getAttachmentFileInput = {
  message_id: z.string().min(1).describe('The message_id the attachment belongs to.'),
  attachment_id: optionalText('attachment_id from a search_mail or get_email result.'),
  filename: optionalText(
    'Attachment filename, case-insensitive. Preferred: attachment ids change between reads.',
  ),
};

export interface AttachmentFileResult {
  attachment_id: string;
  filename: string;
  mime: string;
  size: number;
}

/** URI of the embedded resource. A `mail://` resource may serve the same bytes in phase 6. */
export function attachmentUri(messageId: string, filename: string): string {
  return `mail://attachment/${encodeURIComponent(messageId)}/${encodeURIComponent(filename)}`;
}

function tooLarge(filename: string, size: number, maxBytes: number): MailError {
  return new MailError(
    'ATTACHMENT_UNSUPPORTED',
    `${filename} is ${size} bytes, over the ${maxBytes} byte limit; no bytes were sent.`,
    'Open the message in the mailbox with its link to download large files.',
  );
}

export function registerGetAttachmentFile(server: McpServer, deps: ServerDeps): void {
  const maxBytes = deps.config.limits.maxAttachmentBytes;
  server.registerTool(
    'get_attachment_file',
    {
      title: 'Get attachment file',
      description:
        'Download one attachment exactly as it was sent, by attachment_id or filename. ' +
        'Returns its metadata and the original bytes as a base64 resource block with the mime type; no text is extracted. ' +
        'Attachment ids change between reads, so pass the filename whenever you have it. ' +
        `Files over ${maxBytes} bytes are refused with ATTACHMENT_UNSUPPORTED. ` +
        'Use get_attachment_text when you want to read the file rather than store it.',
      inputSchema: getAttachmentFileInput,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    (args, extra) =>
      withMailbox(deps, extra, async (provider): Promise<CallToolResult> => {
        const meta = await findAttachment(provider, args.message_id, attachmentRef(args));
        // The listed size is checked first so an oversized file is never downloaded.
        if (meta.size > maxBytes) throw tooLarge(meta.filename, meta.size, maxBytes);

        const raw = await provider.getAttachment(args.message_id, meta.attachment_id);
        if (raw.size > maxBytes) throw tooLarge(meta.filename, raw.size, maxBytes);

        const result: AttachmentFileResult = {
          attachment_id: raw.attachment_id,
          filename: meta.filename,
          mime: meta.mime,
          size: raw.size,
        };
        return {
          content: [
            { type: 'text', text: JSON.stringify(result) },
            {
              type: 'resource',
              resource: {
                uri: attachmentUri(args.message_id, meta.filename),
                mimeType: meta.mime,
                blob: Buffer.from(raw.bytes).toString('base64'),
              },
            },
            { type: 'text', text: `${meta.filename} (${meta.mime}, ${raw.size} bytes).` },
          ],
        };
      }),
  );
}
