import { parseAttachment } from '../parse/attachments/index.js';
import { truncate } from '../parse/document.js';
import type { DocumentAttachment, MailProvider, RawMessage } from '../providers/types.js';

export interface AttachmentTextLimits {
  maxBytes: number;
  maxChars: number;
}

/**
 * Fetch and extract every attachment of a message, using the attachment ids
 * from the same read that produced `raw` (Gmail ids change on every read).
 * One attachment failing to fetch or parse marks that one as skipped; the
 * others still come through. Sequential for now; task 4.1 adds concurrency.
 */
export async function attachmentTexts(
  provider: MailProvider,
  raw: RawMessage,
  limits: AttachmentTextLimits,
): Promise<DocumentAttachment[]> {
  const out: DocumentAttachment[] = [];
  for (const meta of raw.attachments) {
    try {
      const bytes = (await provider.getAttachment(raw.message_id, meta.attachment_id)).bytes;
      const parsed = await parseAttachment(
        { mime: meta.mime, filename: meta.filename, bytes },
        { maxBytes: limits.maxBytes },
      );
      const cut = truncate(parsed.text, limits.maxChars);
      out.push({
        ...meta,
        text: parsed.skipped_reason ? null : cut.text,
        truncated: cut.truncated,
        skipped_reason: parsed.skipped_reason,
      });
    } catch {
      out.push({ ...meta, text: null, truncated: false, skipped_reason: 'PARSE_FAILED' });
    }
  }
  return out;
}
