import type { AttachmentSkipReason } from '../../providers/types.js';
import { parseDocx } from './docx.js';
import { parsePdf } from './pdf.js';
import { parseText } from './text.js';
import type { TextKind } from './text.js';

/**
 * Attachment bytes -> text (brief section 11). Pure, async, never throws:
 * every failure is a value with a `skipped_reason`, so one bad file cannot
 * break a call that covers many messages.
 */

export interface AttachmentInput {
  mime: string;
  filename: string;
  bytes: Uint8Array;
}

export interface ParseOptions {
  /** Over this many bytes the attachment is skipped (config MAX_ATTACHMENT_BYTES). */
  maxBytes: number;
}

export interface ParsedAttachment {
  text: string;
  /** Page count for PDFs, null for everything else. */
  pages: number | null;
  skipped_reason: AttachmentSkipReason | null;
}

export type AttachmentKind = 'pdf' | 'docx' | TextKind;

const BY_MIME: Record<string, AttachmentKind> = {
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'text/plain': 'txt',
  'text/markdown': 'md',
  'text/x-markdown': 'md',
  'text/csv': 'csv',
  'text/html': 'html',
};

const BY_EXTENSION: Record<string, AttachmentKind> = {
  pdf: 'pdf',
  docx: 'docx',
  txt: 'txt',
  text: 'txt',
  md: 'md',
  markdown: 'md',
  csv: 'csv',
  html: 'html',
  htm: 'html',
};

/** Mime types that say nothing about the content; only then is the extension consulted. */
const GENERIC_MIMES = new Set([
  '',
  'application/octet-stream',
  'binary/octet-stream',
  'application/x-download',
]);

/** Mime type first; the filename extension only when the mime is generic. A known foreign mime is never second-guessed. */
export function detectKind(mime: string, filename: string): AttachmentKind | null {
  const base = mime.toLowerCase().split(';')[0]?.trim() ?? '';
  const byMime = BY_MIME[base];
  if (byMime) return byMime;
  if (!GENERIC_MIMES.has(base)) return null;

  const ext = filename.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? '';
  return BY_EXTENSION[ext] ?? null;
}

function skipped(reason: AttachmentSkipReason): ParsedAttachment {
  return { text: '', pages: null, skipped_reason: reason };
}

export async function parseAttachment(
  input: AttachmentInput,
  options: ParseOptions,
): Promise<ParsedAttachment> {
  if (input.bytes.byteLength > options.maxBytes) return skipped('ATTACHMENT_UNSUPPORTED');

  const kind = detectKind(input.mime, input.filename);
  if (kind === null) return skipped('ATTACHMENT_UNSUPPORTED');

  try {
    switch (kind) {
      case 'pdf':
        return await parsePdf(input.bytes);
      case 'docx':
        return { text: await parseDocx(input.bytes), pages: null, skipped_reason: null };
      default:
        return { text: parseText(input.bytes, kind), pages: null, skipped_reason: null };
    }
  } catch {
    return skipped('PARSE_FAILED');
  }
}
