import { htmlToText } from '../html-to-text.js';
import { normalizeWhitespace } from '../quotes.js';

export type TextKind = 'txt' | 'md' | 'csv' | 'html';

/** UTF-8 with the BOM dropped; invalid sequences become U+FFFD rather than throwing. */
export function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: false, ignoreBOM: false }).decode(bytes);
}

/** Plain formats are returned as they are, whitespace-normalised. HTML is converted. */
export function parseText(bytes: Uint8Array, kind: TextKind): string {
  const text = decodeUtf8(bytes);
  return kind === 'html' ? htmlToText(text) : normalizeWhitespace(text);
}
