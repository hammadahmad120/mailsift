import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { SEARCH_SYNTAX_URI } from '../resources/search-syntax.js';
import type { ServerDeps } from '../server.js';

/**
 * `build_mail_query` (brief section 12): turn one plain sentence into
 * `search_mail` filter fields. Prefer facts, never invent a sender, say what
 * is missing when there is nothing to filter on. Pure `render` plus a thin
 * `register`; MCP prompt arguments are always strings.
 */
export const BUILD_MAIL_QUERY = 'build_mail_query';

export interface BuildMailQueryArgs {
  request: string;
  /** YYYY-MM-DD. */
  today: string;
  /** Days to look back when the request names no dates. */
  default_window_days: string;
}

export const buildMailQueryArgs = {
  request: z.string().min(1).describe('The plain-language request, one sentence.'),
  today: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD')
    .describe("Today's date as YYYY-MM-DD, so relative words like 'last month' can be resolved."),
  default_window_days: z
    .string()
    .regex(/^\d+$/, 'a whole number of days')
    .describe('How many days back to search when the request names no dates.'),
};

export function renderBuildMailQuery(args: BuildMailQueryArgs, maxRangeDays: number): string {
  return [
    'Turn the request below into filter fields for the search_mail tool. Reply with one JSON object of filters and nothing else, or with one sentence saying what is missing.',
    '',
    `Request: ${args.request}`,
    `Today: ${args.today}`,
    `Default window: ${args.default_window_days} days`,
    '',
    'Rules:',
    `- Read the ${SEARCH_SYNTAX_URI} resource first. Use only the fields it lists: subject, from, to, keywords, any_keywords, after, before, has_attachment, attachment_types, label, raw_query.`,
    '- Prefer facts over guesses: words likely to be in the subject, a sender address or domain the request states, dates, attachment types.',
    '- Never invent a sender. If the request does not name one, leave from empty.',
    `- Resolve relative dates from today. If the request names no dates, set after to today minus the default window. after is inclusive, before is exclusive, both YYYY-MM-DD, and the range may be at most ${maxRangeDays} days.`,
    '- Put words that must all appear in keywords, alternatives in any_keywords. Keep each list short.',
    '- If the request gives nothing to filter on, do not output filters. Say in one sentence what is missing (for example a subject word, a sender, or a date range).',
  ].join('\n');
}

export function registerBuildMailQuery(server: McpServer, deps: ServerDeps): void {
  server.registerPrompt(
    BUILD_MAIL_QUERY,
    {
      title: 'Build a mail query',
      description:
        'Turn a plain-language request into search_mail filters. Prefers facts, never invents a sender, says what is missing.',
      argsSchema: buildMailQueryArgs,
    },
    (args) => ({
      description: `search_mail filters for: ${args.request}`,
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: renderBuildMailQuery(args, deps.config.limits.maxRangeDays),
          },
        },
      ],
    }),
  );
}
