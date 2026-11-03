import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ALWAYS_EXCLUDED, buildQuery } from '../providers/gmail/query-builder.js';
import { ATTACHMENT_TYPES, type SearchFilters } from '../providers/types.js';
import type { ServerDeps } from '../server.js';

/**
 * `mail://search-syntax`: a markdown page a model reads before writing `search_mail` or
 * `collect_mail` filters (brief section 12). Every field, the Gmail syntax it becomes, the rules,
 * and six worked examples whose Gmail queries are produced by the real `buildQuery`, so the page
 * cannot drift from the code. Pure render, no credentials, rendered on every read.
 */
export const SEARCH_SYNTAX_URI = 'mail://search-syntax';

export interface SearchSyntaxOptions {
  /** `MAX_RANGE_DAYS`: the page states the limit this deployment enforces. */
  maxRangeDays: number;
  /** Fixed clock so the examples and tests are stable. */
  now?: Date;
}

interface FieldDoc {
  field: keyof SearchFilters;
  type: string;
  becomes: string;
  notes: string;
}

/** One row per `SearchFilters` field, in the order the query builder emits them. */
export const FIELD_DOCS: readonly FieldDoc[] = [
  {
    field: 'subject',
    type: 'string',
    becomes: '`subject:(words)`',
    notes: 'All words must appear in the subject, any order. Not a phrase match.',
  },
  {
    field: 'from',
    type: 'string',
    becomes: '`from:(words)`',
    notes: 'Address or name fragments. `from: "acme.com"` matches every sender at that domain.',
  },
  {
    field: 'to',
    type: 'string',
    becomes: '`to:(words)`',
    notes: 'Same as `from`, for recipients.',
  },
  {
    field: 'keywords',
    type: 'string[]',
    becomes: 'bare terms, AND',
    notes:
      'Each word must appear somewhere in the message. A term with spaces is quoted as a phrase.',
  },
  {
    field: 'any_keywords',
    type: 'string[]',
    becomes: '`{a b c}`, OR',
    notes: 'At least one must appear. Use for synonyms: `["invoice", "bill", "receipt"]`.',
  },
  {
    field: 'after',
    type: 'YYYY-MM-DD',
    becomes: '`after:YYYY/MM/DD`',
    notes: 'Inclusive. Combined with `before` or today, the span is capped (see rules).',
  },
  {
    field: 'before',
    type: 'YYYY-MM-DD',
    becomes: '`before:YYYY/MM/DD`',
    notes: 'Exclusive: messages strictly before that day.',
  },
  {
    field: 'has_attachment',
    type: 'boolean',
    becomes: '`has:attachment` / `-has:attachment`',
    notes: 'On its own it does not count as a filter; add at least one narrowing field.',
  },
  {
    field: 'attachment_types',
    type: `(${ATTACHMENT_TYPES.map((t) => `"${t}"`).join(' | ')})[]`,
    becomes: '`filename:pdf` or `(filename:pdf OR filename:docx)`',
    notes: 'Matches the attachment file extension. Unknown types are ignored.',
  },
  {
    field: 'label',
    type: 'string',
    becomes: '`label:name`',
    notes: 'Gmail label. Spaces become hyphens, as Gmail expects.',
  },
  {
    field: 'raw_query',
    type: 'string',
    becomes: 'appended as typed',
    notes:
      'Native Gmail search syntax for anything the fields cannot say, e.g. `larger:5M` or `is:unread`.',
  },
];

interface Example {
  title: string;
  filters: SearchFilters;
}

/** Six worked examples. Generic wording only; domain words belong in the README. */
export const EXAMPLES: readonly Example[] = [
  {
    title: 'Messages from one sender about one topic',
    filters: { from: 'billing@example.com', subject: 'statement' },
  },
  {
    title: 'Any of several synonyms, with a PDF attached, in a date window',
    filters: {
      any_keywords: ['quote', 'quotation', 'estimate'],
      attachment_types: ['pdf'],
      after: '2026-01-01',
      before: '2026-04-01',
    },
  },
  {
    title: 'All of several words must appear',
    filters: { keywords: ['renewal', 'contract'], after: '2026-06-01' },
  },
  {
    title: 'A phrase in the subject, no attachments',
    filters: { subject: 'weekly report', has_attachment: false },
  },
  {
    title: 'Everything under a Gmail label from one domain',
    filters: { label: 'Project Alpha', from: 'example.org' },
  },
  {
    title: 'Fields plus native syntax for what the fields cannot say',
    filters: { subject: 'backup', raw_query: 'larger:5M is:unread', after: '2026-09-01' },
  },
];

const FIXED_NOW = new Date('2026-11-03T00:00:00.000Z');

function row(cells: string[]): string {
  return `| ${cells.join(' | ')} |`;
}

/** Pure: the markdown page. */
export function renderSearchSyntax(options: SearchSyntaxOptions): string {
  const now = options.now ?? FIXED_NOW;
  const lines: string[] = [];

  lines.push('# search_mail filters and the Gmail query they become');
  lines.push('');
  lines.push(
    'Use these fields in `search_mail` and `collect_mail`. The server turns them into one Gmail ' +
      'search string. Values are sanitised: quotes and brackets are stripped, so a value can never ' +
      'change the meaning of the query.',
  );
  lines.push('');
  lines.push('## Fields');
  lines.push('');
  lines.push(row(['Field', 'Type', 'Becomes', 'Notes']));
  lines.push(row(['---', '---', '---', '---']));
  for (const f of FIELD_DOCS) {
    lines.push(row([`\`${f.field}\``, `\`${f.type}\``, f.becomes, f.notes]));
  }
  lines.push('');
  lines.push('## Rules');
  lines.push('');
  lines.push(
    `- At least one narrowing field is required: subject, from, to, keywords, any_keywords, after, before, label or raw_query. ` +
      'Otherwise the call fails with `QUERY_EMPTY`. `has_attachment` and `attachment_types` alone are not enough.',
  );
  lines.push(
    `- The span from \`after\` to \`before\` (or to today when \`before\` is not set) may be at most ${options.maxRangeDays} days. ` +
      'Wider is `RANGE_TOO_WIDE`; narrow the window or page through several windows.',
  );
  lines.push(
    `- \`${ALWAYS_EXCLUDED}\` is appended to every query. Spam and trash are never searched.`,
  );
  lines.push('- Dates are `YYYY-MM-DD`. Blank strings and empty lists are treated as not set.');
  lines.push(
    '- Results come newest first. `search_mail` pages with `page_size` and `page_token`; ' +
      '`collect_mail` takes `max_messages` and `order` (`newest_first` or `oldest_first`).',
  );
  lines.push('');
  lines.push('## Examples');
  lines.push('');
  EXAMPLES.forEach((example, index) => {
    const query = buildQuery(example.filters, { maxRangeDays: Number.MAX_SAFE_INTEGER, now });
    lines.push(`### ${index + 1}. ${example.title}`);
    lines.push('');
    lines.push('```json');
    lines.push(JSON.stringify(example.filters, null, 2));
    lines.push('```');
    lines.push('');
    lines.push(`Gmail query: \`${query}\``);
    lines.push('');
  });

  return lines.join('\n').trimEnd() + '\n';
}

export function registerSearchSyntaxResource(server: McpServer, deps: ServerDeps): void {
  server.registerResource(
    'search-syntax',
    SEARCH_SYNTAX_URI,
    {
      title: 'Search syntax',
      description:
        'How to fill search_mail and collect_mail filters: every field, the Gmail syntax it becomes, ' +
        'the rules (required fields, date range cap, spam and trash excluded) and six worked examples. ' +
        'Read this before writing a query.',
      mimeType: 'text/markdown',
    },
    (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: 'text/markdown',
          text: renderSearchSyntax({ maxRangeDays: deps.config.limits.maxRangeDays }),
        },
      ],
    }),
  );
}
