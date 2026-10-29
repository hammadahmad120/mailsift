import { MailError } from '../../errors.js';
import { pLimit } from '../../util/concurrency.js';
import type {
  AttachmentMeta,
  MailProvider,
  MailboxProfile,
  MessageIdPage,
  RawAttachment,
  RawMessage,
  SearchFilters,
  SearchPage,
  SearchResult,
  SearchResultItem,
} from '../types.js';
import type { GmailClient } from './client.js';
import type { GmailMessage } from './mime.js';
import { decodeBase64UrlBytes, findBodyPart, listAttachments, readHeaders } from './mime.js';
import { buildQuery } from './query-builder.js';

/** Shape of Gmail's `users.getProfile` response. */
interface GmailProfileResponse {
  emailAddress?: unknown;
  messagesTotal?: unknown;
  threadsTotal?: unknown;
}

/** Shape of Gmail's `users.messages.list` response. */
interface GmailListResponse {
  messages?: { id?: string; threadId?: string }[];
  nextPageToken?: string;
  resultSizeEstimate?: number;
}

/** Shape of Gmail's `users.messages.attachments.get` response. */
interface GmailAttachmentResponse {
  size?: number;
  /** base64url. */
  data?: string;
}

/** Shape of Gmail's `users.threads.get` response. */
interface GmailThreadResponse {
  id?: string;
  messages?: GmailMessage[];
}

export interface GmailProviderOptions {
  client: GmailClient;
  /** Granted OAuth scopes, supplied by the scope check. Empty until task 2.8 wires it. */
  scopes?: readonly string[];
  /** Widest `after`..`before` span the query builder accepts. Default 365. */
  maxRangeDays?: number;
  /** Injected for tests. Defaults to the current time. */
  now?: () => Date;
  /** Messages fetched at once by `search`. Default 5 (`FETCH_CONCURRENCY`). */
  fetchConcurrency?: number;
}

/** Gmail's own ceiling for `maxResults` on `messages.list`. */
export const GMAIL_LIST_MAX = 500;

/** Gmail message, thread and attachment ids: URL-safe characters only. */
const ID_RE = /^[A-Za-z0-9_=-]+$/;

export function messageLink(messageId: string): string {
  return `https://mail.google.com/mail/u/0/#all/${messageId}`;
}

/**
 * Gmail implementation of MailProvider. All six read methods.
 */
export class GmailProvider implements MailProvider {
  readonly name = 'gmail' as const;
  private readonly client: GmailClient;
  private readonly scopes: readonly string[];
  private readonly maxRangeDays: number;
  private readonly now: () => Date;
  private readonly fetchConcurrency: number;

  constructor(options: GmailProviderOptions) {
    this.client = options.client;
    this.scopes = options.scopes ?? [];
    this.maxRangeDays = options.maxRangeDays ?? 365;
    this.now = options.now ?? (() => new Date());
    this.fetchConcurrency = options.fetchConcurrency ?? 5;
  }

  async getProfile(): Promise<MailboxProfile> {
    const data = await this.client.get<GmailProfileResponse>('profile');

    if (typeof data.emailAddress !== 'string') {
      throw new MailError('PROVIDER_ERROR', 'Gmail profile response had no emailAddress.');
    }

    return {
      email_address: data.emailAddress,
      messages_total: asCount(data.messagesTotal),
      threads_total: asCount(data.threadsTotal),
      provider: this.name,
      scopes: [...this.scopes],
      read_only: true,
    };
  }

  /**
   * One `messages.list` call: ids and paging only, newest first as Gmail
   * orders them. `collect_mail` pages through this before fetching anything.
   */
  async listMessageIds(filters: SearchFilters, page: SearchPage): Promise<MessageIdPage> {
    const query = buildQuery(filters, { maxRangeDays: this.maxRangeDays, now: this.now() });

    const list = await this.client.get<GmailListResponse>('messages', {
      q: query,
      maxResults: Math.min(page.page_size, GMAIL_LIST_MAX),
      pageToken: page.page_token,
    });

    const ids = (list.messages ?? [])
      .map((m) => m.id)
      .filter((id): id is string => typeof id === 'string' && id !== '');

    return {
      query_used: query,
      result_size_estimate: asCount(list.resultSizeEstimate),
      next_page_token: list.nextPageToken ?? null,
      ids,
    };
  }

  /**
   * Two round trips, as Gmail's API is shaped: list ids for the query, then
   * fetch each message for headers, snippet and attachment list. No bodies leave here.
   * Fetches run `fetchConcurrency` at a time; results keep Gmail's order.
   */
  async search(filters: SearchFilters, page: SearchPage): Promise<SearchResult> {
    const list = await this.listMessageIds(filters, page);
    const limit = pLimit(this.fetchConcurrency);
    const items = await Promise.all(
      list.ids.map((id) => limit(async () => toSearchItem(await fetchMessage(this.client, id)))),
    );

    return {
      query_used: list.query_used,
      result_size_estimate: list.result_size_estimate,
      next_page_token: list.next_page_token,
      items,
    };
  }

  async getMessage(messageId: string): Promise<RawMessage> {
    return toRawMessage(await fetchMessage(this.client, messageId));
  }

  /** Messages in the thread, oldest first. */
  async getThread(threadId: string): Promise<RawMessage[]> {
    assertId('thread', threadId);
    const thread = await this.client.get<GmailThreadResponse>(`threads/${threadId}`, {
      format: 'full',
    });
    return (thread.messages ?? [])
      .map((m) => ({ message: m, sortKey: sortKeyOf(m) }))
      .sort((a, b) => a.sortKey - b.sortKey)
      .map(({ message }) => toRawMessage(message));
  }

  /**
   * One call for the bytes. Gmail issues a new attachment id on every message
   * read, so the id must come from the message the caller just fetched; a
   * stale one is a Gmail 404, mapped to NOT_FOUND by the client.
   */
  async getAttachment(messageId: string, attachmentId: string): Promise<RawAttachment> {
    assertId('message', messageId);
    assertId('attachment', attachmentId);

    const data = await this.client.get<GmailAttachmentResponse>(
      `messages/${messageId}/attachments/${attachmentId}`,
    );
    if (typeof data.data !== 'string') {
      throw new MailError('PROVIDER_ERROR', 'Gmail attachment response had no data.');
    }

    const bytes = decodeBase64UrlBytes(data.data);
    return { attachment_id: attachmentId, size: bytes.byteLength, bytes: new Uint8Array(bytes) };
  }
}

async function fetchMessage(client: GmailClient, messageId: string): Promise<GmailMessage> {
  assertId('message', messageId);
  return client.get<GmailMessage>(`messages/${messageId}`, { format: 'full' });
}

/** A malformed id is a NOT_FOUND to the caller, not a path-allow-list surprise. */
function assertId(kind: 'message' | 'thread' | 'attachment', id: string): void {
  if (!ID_RE.test(id)) {
    throw new MailError(
      'NOT_FOUND',
      `"${id}" is not a valid Gmail ${kind} id.`,
      'Use an id from a search_mail result.',
    );
  }
}

function requireId(message: GmailMessage, field: 'id' | 'threadId'): string {
  const value = message[field];
  if (typeof value !== 'string' || value === '') {
    throw new MailError('PROVIDER_ERROR', `Gmail message response had no ${field}.`);
  }
  return value;
}

function toRawMessage(message: GmailMessage): RawMessage {
  const id = requireId(message, 'id');
  return {
    message_id: id,
    thread_id: requireId(message, 'threadId'),
    headers: readHeaders(message.payload, message.internalDate),
    link: messageLink(id),
    body: findBodyPart(message.payload),
    attachments: listAttachments(message.payload),
  };
}

function toSearchItem(message: GmailMessage): SearchResultItem {
  const id = requireId(message, 'id');
  const headers = readHeaders(message.payload, message.internalDate);
  const attachments: AttachmentMeta[] = listAttachments(message.payload);
  return {
    message_id: id,
    thread_id: requireId(message, 'threadId'),
    date: headers.date,
    from: headers.from,
    to: headers.to,
    subject: headers.subject,
    snippet: (message.snippet ?? '').trim(),
    attachments,
    link: messageLink(id),
  };
}

/** Gmail's internalDate (arrival time) when present, else the Date header, else 0. */
function sortKeyOf(message: GmailMessage): number {
  const internal = Number(message.internalDate);
  if (message.internalDate !== undefined && Number.isFinite(internal)) return internal;
  const parsed = Date.parse(readHeaders(message.payload).date);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function asCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}
