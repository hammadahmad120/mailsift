import type { Document, DocumentAttachment, ProviderName, RawMessage } from '../providers/types.js';

/**
 * Build the Document (brief section 9) from provider output. Pure.
 *
 * Phase 2: `text` is the raw body as the provider gave it (plain text, or HTML
 * untouched). Phase 3 replaces `rawBodyText` with the cleaning pipeline and
 * `rawThreadText` with `flattenThread`, at these two call sites only.
 */

export interface DocumentOptions {
  source: ProviderName;
  /** Body cap in characters. Over it, text is cut and `truncated` is true. */
  maxChars: number;
  /** When given, every message of the thread, oldest first, becomes `thread_text`. */
  thread?: readonly RawMessage[];
}

export interface Truncated {
  text: string;
  truncated: boolean;
}

export function truncate(text: string, maxChars: number): Truncated {
  if (maxChars < 0 || text.length <= maxChars) return { text, truncated: false };
  return { text: text.slice(0, maxChars), truncated: true };
}

/** The body as text, with no cleaning yet. Null body means an empty document. */
export function rawBodyText(raw: RawMessage): string {
  return raw.body?.content ?? '';
}

/** `--- From <from> on <date> ---` before each message, oldest first (brief section 11). */
export function rawThreadText(messages: readonly RawMessage[]): string {
  return messages
    .map(
      (m) =>
        `--- From ${m.headers.from || 'unknown'} on ${m.headers.date || 'unknown date'} ---\n${rawBodyText(m)}`,
    )
    .join('\n\n');
}

/** Attachments listed only: `text: null`, nothing extracted. Phase 3 fills text. */
export function listedAttachments(raw: RawMessage): DocumentAttachment[] {
  return raw.attachments.map((a) => ({ ...a, text: null, truncated: false, skipped_reason: null }));
}

export function toDocument(raw: RawMessage, options: DocumentOptions): Document {
  const body = truncate(rawBodyText(raw), options.maxChars);

  const document: Document = {
    id: `${options.source}:${raw.message_id}`,
    source: options.source,
    kind: 'email',
    reference: { message_id: raw.message_id, thread_id: raw.thread_id, link: raw.link },
    headers: { ...raw.headers, to: [...raw.headers.to], cc: [...raw.headers.cc] },
    text: body.text,
    attachments: listedAttachments(raw),
    truncated: body.truncated,
  };

  if (options.thread) {
    const thread = truncate(rawThreadText(options.thread), options.maxChars);
    document.thread_text = thread.text;
    if (thread.truncated) document.truncated = true;
  }

  return document;
}
