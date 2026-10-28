/**
 * Provider-neutral types. Every mail provider (Gmail now, IMAP and Microsoft 365 later)
 * produces exactly these shapes. Tools depend on this file only, never on a provider.
 *
 * Design brief: section 8 (tool inputs/outputs) and section 9 (Document shape).
 */

export type ProviderName = 'gmail';

// ---------------------------------------------------------------------------
// Search input (brief 8.1)
// ---------------------------------------------------------------------------

export const ATTACHMENT_TYPES = ['pdf', 'docx', 'txt', 'md', 'csv', 'html'] as const;
export type AttachmentType = (typeof ATTACHMENT_TYPES)[number];

/** Facts to filter on. All optional, but at least one must be set (or raw_query). */
export interface SearchFilters {
  subject?: string;
  from?: string;
  to?: string;
  /** Words that must all appear (AND). */
  keywords?: string[];
  /** Words where at least one must appear (OR). */
  any_keywords?: string[];
  /** YYYY-MM-DD, inclusive. */
  after?: string;
  /** YYYY-MM-DD, exclusive. */
  before?: string;
  has_attachment?: boolean;
  attachment_types?: AttachmentType[];
  label?: string;
  /** Provider-native query syntax, appended to the generated query. */
  raw_query?: string;
}

export interface SearchPage {
  page_size: number;
  page_token?: string;
}

// ---------------------------------------------------------------------------
// Search output (brief 8.1), metadata only, never bodies
// ---------------------------------------------------------------------------

export interface AttachmentMeta {
  attachment_id: string;
  filename: string;
  mime: string;
  size: number;
}

export interface SearchResultItem {
  message_id: string;
  thread_id: string;
  /** ISO 8601. */
  date: string;
  from: string;
  to: string[];
  subject: string;
  snippet: string;
  attachments: AttachmentMeta[];
  /** Deep link back to the message in the provider's UI. */
  link: string;
}

export interface SearchResult {
  query_used: string;
  result_size_estimate: number;
  next_page_token: string | null;
  items: SearchResultItem[];
}

// ---------------------------------------------------------------------------
// Document (brief section 9), the only output shape for mail content
// ---------------------------------------------------------------------------

export type AttachmentSkipReason = 'ATTACHMENT_UNSUPPORTED' | 'PARSE_FAILED' | 'NO_TEXT_LAYER';

export interface DocumentAttachment extends AttachmentMeta {
  /** Extracted text, or null when not extracted (listed only) or skipped. */
  text: string | null;
  truncated: boolean;
  skipped_reason: AttachmentSkipReason | null;
}

export interface DocumentReference {
  message_id: string;
  thread_id: string;
  link: string;
}

export interface DocumentHeaders {
  /** ISO 8601. */
  date: string;
  from: string;
  to: string[];
  cc: string[];
  subject: string;
}

export interface Document {
  /** `${source}:${message_id}` */
  id: string;
  source: ProviderName;
  kind: 'email';
  reference: DocumentReference;
  headers: DocumentHeaders;
  /** Clean body text: quoted replies and signature removed. */
  text: string;
  /** All messages in the thread, flattened in date order. Only when requested. */
  thread_text?: string;
  attachments: DocumentAttachment[];
  truncated: boolean;
}

// ---------------------------------------------------------------------------
// Profile (brief 8.5)
// ---------------------------------------------------------------------------

export interface MailboxProfile {
  email_address: string;
  messages_total: number;
  threads_total: number;
  provider: ProviderName;
  scopes: string[];
  read_only: true;
}

// ---------------------------------------------------------------------------
// Raw provider outputs (before cleaning). The provider returns these; the
// parse layer turns them into a Document.
// ---------------------------------------------------------------------------

export interface RawMessage {
  message_id: string;
  thread_id: string;
  headers: DocumentHeaders;
  link: string;
  /** Body as the provider gave it: plain text preferred, else HTML. */
  body: { kind: 'text' | 'html'; content: string } | null;
  attachments: AttachmentMeta[];
}

/**
 * Attachment bytes only. Gmail's attachment endpoint returns no filename or mime,
 * and attachment ids change on every message read, so metadata always comes from
 * the message the caller has just read, never from a second lookup by id.
 */
export interface RawAttachment {
  attachment_id: string;
  size: number;
  bytes: Uint8Array;
}

// ---------------------------------------------------------------------------
// The provider interface. Exactly five read methods. Nothing else, ever.
// ---------------------------------------------------------------------------

export interface MailProvider {
  readonly name: ProviderName;
  getProfile(): Promise<MailboxProfile>;
  search(filters: SearchFilters, page: SearchPage): Promise<SearchResult>;
  getMessage(messageId: string): Promise<RawMessage>;
  /** Messages in the thread, ordered oldest to newest. */
  getThread(threadId: string): Promise<RawMessage[]>;
  /** Bytes for an attachment id taken from a *fresh* read of the message. */
  getAttachment(messageId: string, attachmentId: string): Promise<RawAttachment>;
}
