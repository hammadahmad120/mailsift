import type { Document, DocumentAttachment, ProviderName, RawMessage } from '../providers/types.js';
import { bodyToText, flattenThread } from './thread.js';

/**
 * Build the Document (brief section 9) from provider output. Pure.
 * `text` and `thread_text` are cleaned through the section 11 pipeline.
 */

export interface DocumentOptions {
  source: ProviderName;
  /** Body cap in characters. Over it, text is cut and `truncated` is true. */
  maxChars: number;
  /** When given, every message of the thread, oldest first, becomes `thread_text`. */
  thread?: readonly RawMessage[];
  /** Attachments with text already filled. Default: listed only, `text: null`. */
  attachments?: DocumentAttachment[];
}

export interface Truncated {
  text: string;
  truncated: boolean;
}

export function truncate(text: string, maxChars: number): Truncated {
  if (maxChars < 0 || text.length <= maxChars) return { text, truncated: false };
  return { text: text.slice(0, maxChars), truncated: true };
}

/** Attachments listed only: `text: null`, nothing extracted. */
export function listedAttachments(raw: RawMessage): DocumentAttachment[] {
  return raw.attachments.map((a) => ({ ...a, text: null, truncated: false, skipped_reason: null }));
}

export function toDocument(raw: RawMessage, options: DocumentOptions): Document {
  const body = truncate(bodyToText(raw), options.maxChars);

  const document: Document = {
    id: `${options.source}:${raw.message_id}`,
    source: options.source,
    kind: 'email',
    reference: { message_id: raw.message_id, thread_id: raw.thread_id, link: raw.link },
    headers: { ...raw.headers, to: [...raw.headers.to], cc: [...raw.headers.cc] },
    text: body.text,
    attachments: options.attachments ?? listedAttachments(raw),
    truncated: body.truncated,
  };

  if (options.thread) {
    const thread = truncate(flattenThread(options.thread), options.maxChars);
    document.thread_text = thread.text;
    if (thread.truncated) document.truncated = true;
  }

  return document;
}
