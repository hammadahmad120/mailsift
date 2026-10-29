import { parseAttachment } from '../parse/attachments/index.js';
import { truncate } from '../parse/document.js';
import type { DocumentAttachment, MailProvider, RawMessage } from '../providers/types.js';
import { pLimit } from '../util/concurrency.js';

export interface AttachmentTextLimits {
  maxBytes: number;
  maxChars: number;
  /** Attachments fetched at once. Default 1 (one message's attachments, in order). */
  concurrency?: number;
}

/**
 * Fetch and extract every attachment of a message, using the attachment ids
 * from the same read that produced `raw` (Gmail ids change on every read).
 * One attachment failing to fetch or parse marks that one as skipped; the
 * others still come through. Results keep the message's attachment order.
 */
export async function attachmentTexts(
  provider: MailProvider,
  raw: RawMessage,
  limits: AttachmentTextLimits,
): Promise<DocumentAttachment[]> {
  const limit = pLimit(limits.concurrency ?? 1);
  return Promise.all(
    raw.attachments.map((meta) =>
      limit(async (): Promise<DocumentAttachment> => {
        try {
          const bytes = (await provider.getAttachment(raw.message_id, meta.attachment_id)).bytes;
          const parsed = await parseAttachment(
            { mime: meta.mime, filename: meta.filename, bytes },
            { maxBytes: limits.maxBytes },
          );
          const cut = truncate(parsed.text, limits.maxChars);
          return {
            ...meta,
            text: parsed.skipped_reason ? null : cut.text,
            truncated: cut.truncated,
            skipped_reason: parsed.skipped_reason,
          };
        } catch {
          return { ...meta, text: null, truncated: false, skipped_reason: 'PARSE_FAILED' };
        }
      }),
    ),
  );
}
