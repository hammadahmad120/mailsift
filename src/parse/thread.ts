import type { RawMessage } from '../providers/types.js';
import { htmlToText } from './html-to-text.js';
import { cleanBody } from './quotes.js';

/**
 * Thread flattening (brief section 11): messages in date order, each prefixed
 * by `--- From <from> on <date> ---`, each body cleaned. Pure.
 */

/** One message body as clean text: HTML converted first, then quotes, signature, whitespace. */
export function bodyToText(raw: RawMessage): string {
  if (!raw.body) return '';
  const text = raw.body.kind === 'html' ? htmlToText(raw.body.content) : raw.body.content;
  return cleanBody(text);
}

export function threadSeparator(raw: RawMessage): string {
  return `--- From ${raw.headers.from || 'unknown'} on ${raw.headers.date || 'unknown date'} ---`;
}

/** Sort key: the ISO date header, or the start of time when missing or unparseable. */
function dateKey(raw: RawMessage): number {
  const ms = Date.parse(raw.headers.date);
  return Number.isNaN(ms) ? Number.NEGATIVE_INFINITY : ms;
}

/**
 * Oldest first (stable, so equal dates keep provider order), one block per
 * message. A message with no readable body still gets its separator line so
 * the sequence of the conversation stays visible.
 */
export function flattenThread(messages: readonly RawMessage[]): string {
  return [...messages]
    .sort((a, b) => dateKey(a) - dateKey(b))
    .map((m) => `${threadSeparator(m)}\n${bodyToText(m)}`)
    .join('\n\n');
}
