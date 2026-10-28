import type { AttachmentMeta, DocumentHeaders } from '../types.js';

/**
 * Pure helpers over Gmail's `users.messages.get` (format=full) payload.
 *
 * Gmail returns a nested MIME tree. These functions flatten it so the provider
 * stays small: pick a body, decode it, read headers, list attachments.
 * No network, no client, no state.
 */

// ---------------------------------------------------------------------------
// Gmail wire shapes (only the fields we read)
// ---------------------------------------------------------------------------

export interface GmailHeader {
  name?: string;
  value?: string;
}

export interface GmailBody {
  attachmentId?: string;
  size?: number;
  /** base64url, present for parts Gmail inlines in the response. */
  data?: string;
}

export interface GmailPart {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: GmailHeader[];
  body?: GmailBody;
  parts?: GmailPart[];
}

export interface GmailMessage {
  id?: string;
  threadId?: string;
  snippet?: string;
  /** Epoch milliseconds as a string. */
  internalDate?: string;
  labelIds?: string[];
  payload?: GmailPart;
}

export interface BodyPart {
  kind: 'text' | 'html';
  content: string;
}

// ---------------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------------

/** Gmail body data is base64url (RFC 4648 section 5), padding optional. Decoded as UTF-8. */
export function decodeBase64Url(data: string): string {
  return decodeBase64UrlBytes(data).toString('utf8');
}

export function decodeBase64UrlBytes(data: string): Buffer {
  return Buffer.from(data.trim(), 'base64url');
}

// ---------------------------------------------------------------------------
// Tree walking
// ---------------------------------------------------------------------------

/** Depth-first, parents before children. */
export function walkParts(root: GmailPart | undefined): GmailPart[] {
  const out: GmailPart[] = [];
  const visit = (part: GmailPart): void => {
    out.push(part);
    for (const child of part.parts ?? []) visit(child);
  };
  if (root) visit(root);
  return out;
}

function mimeOf(part: GmailPart): string {
  return (part.mimeType ?? '').toLowerCase().split(';')[0]?.trim() ?? '';
}

function headerOf(part: GmailPart, name: string): string | undefined {
  const lower = name.toLowerCase();
  return part.headers?.find((h) => (h.name ?? '').toLowerCase() === lower)?.value;
}

function isAttachmentLike(part: GmailPart): boolean {
  return (part.filename ?? '') !== '';
}

/**
 * The body a reader would see: the first non-empty `text/plain` part, else the
 * first non-empty `text/html` part. Parts with a filename are attachments, not body.
 */
export function findBodyPart(payload: GmailPart | undefined): BodyPart | null {
  let html: string | null = null;

  for (const part of walkParts(payload)) {
    if (isAttachmentLike(part)) continue;
    const data = part.body?.data;
    if (!data) continue;

    const mime = mimeOf(part);
    if (mime === 'text/plain') {
      const text = decodeBase64Url(data);
      if (text.trim() !== '') return { kind: 'text', content: text };
    } else if (mime === 'text/html' && html === null) {
      const text = decodeBase64Url(data);
      if (text.trim() !== '') html = text;
    }
  }

  return html === null ? null : { kind: 'html', content: html };
}

// ---------------------------------------------------------------------------
// Headers
// ---------------------------------------------------------------------------

/**
 * Split an address header on commas that are outside quotes and angle brackets,
 * so `"Doe, Jane" <jane@example.com>, bob@example.com` gives two entries.
 */
export function splitAddresses(value: string | undefined): string[] {
  if (!value) return [];
  const out: string[] = [];
  let current = '';
  let inQuotes = false;
  let depth = 0;

  for (const ch of value) {
    if (ch === '"') inQuotes = !inQuotes;
    else if (!inQuotes && ch === '<') depth++;
    else if (!inQuotes && ch === '>') depth = Math.max(0, depth - 1);

    if (ch === ',' && !inQuotes && depth === 0) {
      out.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  out.push(current);

  return out.map((s) => s.replace(/\s+/g, ' ').trim()).filter((s) => s !== '');
}

/** RFC 2822 `Date` header to ISO 8601, falling back to Gmail's `internalDate`, else ''. */
export function toIsoDate(dateHeader: string | undefined, internalDate?: string): string {
  if (dateHeader) {
    const parsed = new Date(dateHeader);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  if (internalDate) {
    const ms = Number(internalDate);
    if (Number.isFinite(ms)) return new Date(ms).toISOString();
  }
  return '';
}

export function readHeaders(
  payload: GmailPart | undefined,
  internalDate?: string,
): DocumentHeaders {
  const get = (name: string): string | undefined => (payload ? headerOf(payload, name) : undefined);
  return {
    date: toIsoDate(get('Date'), internalDate),
    from: (get('From') ?? '').replace(/\s+/g, ' ').trim(),
    to: splitAddresses(get('To')),
    cc: splitAddresses(get('Cc')),
    subject: (get('Subject') ?? '').replace(/\s+/g, ' ').trim(),
  };
}

// ---------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------

/**
 * Real attachments only: parts with a filename and an attachment id.
 * Inline parts (disposition `inline`, or a Content-ID with no disposition) are
 * images embedded in the HTML, not documents, and are left out.
 */
export function listAttachments(payload: GmailPart | undefined): AttachmentMeta[] {
  const out: AttachmentMeta[] = [];

  for (const part of walkParts(payload)) {
    if (!isAttachmentLike(part)) continue;
    const attachmentId = part.body?.attachmentId;
    if (!attachmentId) continue;

    const disposition = (headerOf(part, 'Content-Disposition') ?? '').toLowerCase().trim();
    const inline =
      disposition.startsWith('inline') ||
      (disposition === '' && headerOf(part, 'Content-ID') !== undefined);
    if (inline) continue;

    out.push({
      attachment_id: attachmentId,
      filename: part.filename as string,
      mime: mimeOf(part) || 'application/octet-stream',
      size: typeof part.body?.size === 'number' ? part.body.size : 0,
    });
  }

  return out;
}
