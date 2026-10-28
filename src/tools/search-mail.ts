import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { toToolError } from '../errors.js';
import { ATTACHMENT_TYPES } from '../providers/types.js';
import type { SearchFilters, SearchPage } from '../providers/types.js';
import type { ServerDeps } from '../server.js';
import { toolResult } from './result.js';

/**
 * `search_mail`: find messages by facts (brief 8.1). Metadata only, never bodies.
 * Input mirrors `SearchFilters` plus paging. The field descriptions are what the
 * model reads, so they say how each maps to the mailbox search.
 */

const DATE = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
  .describe('YYYY-MM-DD');

const words = (what: string) => z.array(z.string().min(1)).min(1).describe(what);

export const searchMailInput = {
  subject: z.string().min(1).optional().describe('Words that must all appear in the subject.'),
  from: z.string().min(1).optional().describe('Sender address or name.'),
  to: z.string().min(1).optional().describe('Recipient address or name.'),
  keywords: words('Words that must all appear anywhere in the message (AND).').optional(),
  any_keywords: words('Words where at least one must appear (OR).').optional(),
  after: DATE.optional().describe('Only messages on or after this date (YYYY-MM-DD).'),
  before: DATE.optional().describe('Only messages before this date (YYYY-MM-DD, exclusive).'),
  has_attachment: z.boolean().optional().describe('true: only messages with attachments.'),
  attachment_types: z
    .array(z.enum(ATTACHMENT_TYPES))
    .min(1)
    .optional()
    .describe('Only messages with an attachment of one of these file types.'),
  label: z.string().min(1).optional().describe('Mailbox label name.'),
  raw_query: z
    .string()
    .min(1)
    .optional()
    .describe('Provider-native search syntax, appended to the generated query.'),
  page_size: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe('Results per page. Default 25. Values above the server cap are lowered to it.'),
  page_token: z.string().min(1).optional().describe('next_page_token from a previous reply.'),
};

const DEFAULT_PAGE_SIZE = 25;

type SearchMailArgs = z.infer<z.ZodObject<typeof searchMailInput>>;

/** Split validated args into provider filters and paging; drop undefined keys. */
export function toSearchCall(
  args: SearchMailArgs,
  maxPageSize: number,
): { filters: SearchFilters; page: SearchPage } {
  const { page_size, page_token, ...rest } = args;
  const filters: SearchFilters = {};
  for (const [key, value] of Object.entries(rest)) {
    if (value !== undefined) (filters as Record<string, unknown>)[key] = value;
  }
  const page: SearchPage = {
    page_size: Math.min(page_size ?? DEFAULT_PAGE_SIZE, maxPageSize),
  };
  if (page_token !== undefined) page.page_token = page_token;
  return { filters, page };
}

export function registerSearchMail(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    'search_mail',
    {
      title: 'Search mail',
      description:
        'Find messages by subject, sender, recipient, keywords, dates, attachments or label. ' +
        'Returns metadata only (ids, date, from, to, subject, snippet, attachment names, link), ' +
        'never message bodies. Give at least one filter. ' +
        `Pages of up to ${deps.config.limits.maxPageSize}; pass next_page_token to continue. ` +
        `Date ranges wider than ${deps.config.limits.maxRangeDays} days are rejected. ` +
        'Spam and trash are always excluded.',
      inputSchema: searchMailInput,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args, extra) => {
      try {
        const { filters, page } = toSearchCall(args, deps.config.limits.maxPageSize);
        const credentials = await deps.resolveCredentials(extra);
        const provider = deps.createProvider(credentials);
        const result = await provider.search(filters, page);

        const more = result.next_page_token ? ' More pages available.' : '';
        return toolResult(
          result,
          `Found about ${result.result_size_estimate} matching messages, ` +
            `showing ${result.items.length}.${more} Query: ${result.query_used}`,
        );
      } catch (err) {
        return toToolError(err);
      }
    },
  );
}
