import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ErrorCode } from '../errors.js';
import { MailError } from '../errors.js';
import { listedAttachments, toDocument } from '../parse/document.js';
import type {
  AttachmentSkipReason,
  Document,
  DocumentAttachment,
  MailProvider,
  SearchFilters,
} from '../providers/types.js';
import type { ServerDeps } from '../server.js';
import { pLimit } from '../util/concurrency.js';
import { attachmentTexts } from './attachment-texts.js';
import { ATTACHMENT_MODES } from './get-email.js';
import { toolResult } from './result.js';
import { searchMailInput, toSearchCall } from './search-mail.js';
import { withMailbox } from './with-mailbox.js';

/**
 * `collect_mail`: the one-call bundle (brief 8.4). Same filters as `search_mail`,
 * then every matching message as a Document, under hard caps, with `skipped`
 * and `stats` so the caller knows exactly what it did not get.
 *
 * Shape of the work:
 *   1. page through message ids (cheap, nothing fetched) until `max_messages`
 *      or the end; `oldest_first` walks to the end (capped by MAX_SEARCH_IDS)
 *      and reverses;
 *   2. fetch and convert messages `FETCH_CONCURRENCY` at a time, same code as
 *      `get_email`, one failure skipping only that message;
 *   3. add documents in id order until `max_total_chars`; the rest, fetched or
 *      not, are listed in `skipped` as MAX_TOTAL_CHARS so they can be read one
 *      by one.
 */

export const COLLECT_ORDERS = ['newest_first', 'oldest_first'] as const;
export type CollectOrder = (typeof COLLECT_ORDERS)[number];

const DEFAULT_MAX_MESSAGES = 50;

// Filters only: paging is the tool's own business.
const { page_size: _pageSize, page_token: _pageToken, ...filterInput } = searchMailInput;

export const collectMailInput = {
  ...filterInput,
  max_messages: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe(
      `Most messages to return. Default ${DEFAULT_MAX_MESSAGES}. Values above the server cap are lowered to it.`,
    ),
  order: z
    .enum(COLLECT_ORDERS)
    .optional()
    .describe(
      '"newest_first" (default): the most recent matches, as the mailbox lists them. ' +
        '"oldest_first": the earliest matches, for working through a backlog in arrival order.',
    ),
  include_thread: z
    .boolean()
    .optional()
    .describe('true: each document also carries thread_text, its whole conversation oldest first.'),
  attachments: z
    .enum(ATTACHMENT_MODES)
    .optional()
    .describe(
      '"text" (default): extract each attachment\'s text (pdf, docx, txt, md, csv, html). ' +
        '"list": names, types and sizes only. "none": omit attachments.',
    ),
  max_total_chars: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe(
      'Stop adding documents once the reply holds this many characters of text. Default from server config.',
    ),
};

export type SkipReason = ErrorCode | AttachmentSkipReason | 'MAX_TOTAL_CHARS';

export interface CollectSkipped {
  message_id: string;
  /** Present when one attachment was skipped, absent when the whole message was. */
  filename?: string;
  reason: SkipReason;
}

export interface CollectStats {
  /** Matching messages, exact when the walk reached the end, else the provider's estimate. */
  messages_found: number;
  messages_returned: number;
  /** Attachments in the returned documents that were not skipped (extracted, or listed in "list" mode). */
  attachments_returned: number;
  /** Characters of text in the returned documents: body, thread_text and attachment text. */
  total_chars: number;
  /** true when any cap kept a matching message out of `documents`. */
  truncated: boolean;
}

export interface CollectResult {
  query_used: string;
  documents: Document[];
  skipped: CollectSkipped[];
  stats: CollectStats;
}

export interface CollectLimits {
  maxMessages: number;
  maxSearchIds: number;
  maxTotalChars: number;
  maxMessageChars: number;
  maxAttachmentBytes: number;
  maxAttachmentChars: number;
  fetchConcurrency: number;
}

export interface CollectOptions {
  filters: SearchFilters;
  order: CollectOrder;
  includeThread: boolean;
  attachments: (typeof ATTACHMENT_MODES)[number];
  limits: CollectLimits;
}

interface IdWalk {
  query_used: string;
  ids: string[];
  /** true when ids beyond `ids` exist that were not walked. */
  more: boolean;
  estimate: number;
}

/** Step 1: ids only. */
async function walkIds(provider: MailProvider, options: CollectOptions): Promise<IdWalk> {
  const { maxMessages, maxSearchIds } = options.limits;
  const wanted = options.order === 'newest_first' ? maxMessages : maxSearchIds;
  const ids: string[] = [];
  let page = await provider.listMessageIds(options.filters, { page_size: wanted });
  const query_used = page.query_used;
  let estimate = page.result_size_estimate;
  let more = false;

  for (;;) {
    estimate = Math.max(estimate, page.result_size_estimate);
    ids.push(...page.ids);
    if (ids.length >= wanted) {
      more = ids.length > wanted || page.next_page_token !== null;
      ids.length = wanted;
      break;
    }
    if (!page.next_page_token || page.ids.length === 0) break;
    page = await provider.listMessageIds(options.filters, {
      page_size: wanted - ids.length,
      page_token: page.next_page_token,
    });
  }

  if (options.order === 'oldest_first') {
    ids.reverse();
    if (ids.length > maxMessages) {
      ids.length = maxMessages;
      more = true;
    }
  }
  return { query_used, ids, more, estimate };
}

function charsOf(document: Document): number {
  let n = document.text.length + (document.thread_text?.length ?? 0);
  for (const a of document.attachments) n += a.text?.length ?? 0;
  return n;
}

function reasonOf(err: unknown): ErrorCode {
  return err instanceof MailError ? err.code : 'PROVIDER_ERROR';
}

/** Step 2 for one message: the same path `get_email` takes. */
async function fetchDocument(
  provider: MailProvider,
  id: string,
  options: CollectOptions,
): Promise<Document> {
  const raw = await provider.getMessage(id);
  const thread = options.includeThread ? await provider.getThread(raw.thread_id) : undefined;

  let attachments: DocumentAttachment[];
  if (options.attachments === 'none') attachments = [];
  else if (options.attachments === 'text') {
    attachments = await attachmentTexts(provider, raw, {
      maxBytes: options.limits.maxAttachmentBytes,
      maxChars: options.limits.maxAttachmentChars,
    });
  } else attachments = listedAttachments(raw);

  return toDocument(raw, {
    source: provider.name,
    maxChars: options.limits.maxMessageChars,
    attachments,
    ...(thread ? { thread } : {}),
  });
}

type Fetched =
  | { kind: 'document'; document: Document }
  | { kind: 'failed'; reason: ErrorCode }
  | { kind: 'unfetched' };

/** The whole collection, independent of MCP so it can be tested and reused. */
export async function collectMail(
  provider: MailProvider,
  options: CollectOptions,
): Promise<CollectResult> {
  const walk = await walkIds(provider, options);
  const { maxTotalChars, fetchConcurrency } = options.limits;

  // Step 2: fetch in id order, n at a time. Once the documents finished so far
  // already fill the cap, tasks that have not started yet return without
  // fetching: the ordered pass below can never need them (every finished task
  // sits earlier in the order than any task that has not started).
  const limit = pLimit(fetchConcurrency);
  let running = 0;
  let full = false;
  const fetched: Fetched[] = await Promise.all(
    walk.ids.map((id) =>
      limit(async (): Promise<Fetched> => {
        if (full) return { kind: 'unfetched' };
        try {
          const document = await fetchDocument(provider, id, options);
          running += charsOf(document);
          if (running >= maxTotalChars) full = true;
          return { kind: 'document', document };
        } catch (err) {
          return { kind: 'failed', reason: reasonOf(err) };
        }
      }),
    ),
  );

  // Step 3: the ordered pass applies the cap exactly.
  const documents: Document[] = [];
  const skipped: CollectSkipped[] = [];
  let total = 0;
  let capped = false;
  walk.ids.forEach((message_id, i) => {
    const item = fetched[i]!;
    if (item.kind === 'failed') {
      skipped.push({ message_id, reason: item.reason });
      return;
    }
    if (capped || item.kind === 'unfetched') {
      capped = true;
      skipped.push({ message_id, reason: 'MAX_TOTAL_CHARS' });
      return;
    }
    const chars = charsOf(item.document);
    if (total + chars > maxTotalChars) {
      capped = true;
      skipped.push({ message_id, reason: 'MAX_TOTAL_CHARS' });
      return;
    }
    total += chars;
    documents.push(item.document);
    for (const a of item.document.attachments) {
      if (a.skipped_reason)
        skipped.push({ message_id, filename: a.filename, reason: a.skipped_reason });
    }
  });

  let attachments_returned = 0;
  for (const d of documents) {
    attachments_returned += d.attachments.filter((a) => a.skipped_reason === null).length;
  }

  return {
    query_used: walk.query_used,
    documents,
    skipped,
    stats: {
      messages_found: walk.more ? Math.max(walk.estimate, walk.ids.length) : walk.ids.length,
      messages_returned: documents.length,
      attachments_returned,
      total_chars: total,
      truncated: walk.more || capped,
    },
  };
}

export function registerCollectMail(server: McpServer, deps: ServerDeps): void {
  const { limits } = deps.config;
  server.registerTool(
    'collect_mail',
    {
      title: 'Collect mail',
      description:
        'Every message matching the filters as clean documents in one call: headers, body text ' +
        '(quoted replies and signatures removed), attachment text, links. Same filters as search_mail. ' +
        `Returns at most max_messages (default ${DEFAULT_MAX_MESSAGES}, cap ${limits.maxCollectMessages}) ` +
        `and stops adding documents at max_total_chars (default ${limits.maxTotalChars}). ` +
        'Use order "oldest_first" to work through a backlog from the start. ' +
        'The reply lists what was skipped and why, and stats.truncated tells you whether a cap cut the result; ' +
        'skipped messages can still be read one at a time with get_email.',
      inputSchema: collectMailInput,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    (args, extra) =>
      withMailbox(deps, extra, async (provider) => {
        const { filters } = toSearchCall(args, limits.maxPageSize);
        const result = await collectMail(provider, {
          filters,
          order: args.order ?? 'newest_first',
          includeThread: args.include_thread ?? false,
          attachments: args.attachments ?? 'text',
          limits: {
            maxMessages: Math.min(
              args.max_messages ?? DEFAULT_MAX_MESSAGES,
              limits.maxCollectMessages,
            ),
            maxSearchIds: limits.maxSearchIds,
            maxTotalChars: Math.min(
              args.max_total_chars ?? limits.maxTotalChars,
              limits.maxTotalChars,
            ),
            maxMessageChars: limits.maxMessageChars,
            maxAttachmentBytes: limits.maxAttachmentBytes,
            maxAttachmentChars: limits.maxAttachmentChars,
            fetchConcurrency: limits.fetchConcurrency,
          },
        });

        const { stats } = result;
        const found = stats.truncated ? `about ${stats.messages_found}` : `${stats.messages_found}`;
        const parts = [
          `Collected ${stats.messages_returned} of ${found} matching messages`,
          `${stats.attachments_returned} attachment(s)`,
          `${stats.total_chars} chars`,
        ];
        if (result.skipped.length) parts.push(`${result.skipped.length} skipped (see skipped[])`);
        if (stats.truncated) parts.push('truncated by a cap');
        return toolResult(result, `${parts.join(', ')}. Query: ${result.query_used}`);
      }),
  );
}
