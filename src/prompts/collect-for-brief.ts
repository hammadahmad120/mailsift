import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { SEARCH_SYNTAX_URI } from '../resources/search-syntax.js';
import type { ServerDeps } from '../server.js';

/**
 * `collect_for_brief` (brief section 12): the workflow a model follows to
 * gather every message matching a brief. Search, inspect count and subjects,
 * refine at most twice (narrow when over the cap, widen when under three),
 * then collect_mail, then stop. Only listed tools. If still unsure after two
 * refinements, report what was found and ask one question.
 */
export const COLLECT_FOR_BRIEF = 'collect_for_brief';

export interface CollectForBriefArgs {
  brief: string;
  /** Optional free text: subject words, sender, dates the caller already knows. */
  hints?: string | undefined;
}

export const collectForBriefArgs = {
  brief: z.string().min(1).describe('What to collect, in plain language.'),
  hints: z
    .string()
    .optional()
    .describe('Optional: subject words, a sender, or dates already known. Free text.'),
};

export interface CollectForBriefLimits {
  maxCollectMessages: number;
  maxRangeDays: number;
}

export const MAX_REFINEMENTS = 2;
export const MIN_USEFUL_RESULTS = 3;

export function renderCollectForBrief(
  args: CollectForBriefArgs,
  limits: CollectForBriefLimits,
): string {
  const hints = args.hints?.trim();
  return [
    'Collect every mailbox message that matches the brief below, using only the tools this server lists. The mailbox is read-only.',
    '',
    `Brief: ${args.brief}`,
    `Hints: ${hints || 'none'}`,
    '',
    'Steps:',
    `1. Read the ${SEARCH_SYNTAX_URI} resource. Build filters from the brief and hints: subject words, sender, dates, attachment types. Never invent a sender.`,
    '2. Call search_mail with those filters. Look at result_size_estimate and the subjects on the first page.',
    `3. Refine at most ${MAX_REFINEMENTS} times. If the estimate is over ${limits.maxCollectMessages}, narrow: add a subject word, a sender, or a tighter date range (at most ${limits.maxRangeDays} days). If it is under ${MIN_USEFUL_RESULTS}, widen: drop the least certain filter or extend the dates. Do not refine when the results already look right.`,
    '4. Call collect_mail once with the final filters. Do not page through search_mail results yourself.',
    '5. Stop. Report query_used, stats, and skipped from the collect_mail reply.',
    '',
    `If after ${MAX_REFINEMENTS} refinements you are still unsure the filters match the brief, do not collect. Report what search_mail found and ask one question.`,
    'Never call a tool that is not in the list, and never try to send, change, label, or delete mail.',
  ].join('\n');
}

export function registerCollectForBrief(server: McpServer, deps: ServerDeps): void {
  server.registerPrompt(
    COLLECT_FOR_BRIEF,
    {
      title: 'Collect mail for a brief',
      description:
        'The search, refine (at most twice), collect_mail, stop workflow for gathering every message that matches a brief.',
      argsSchema: collectForBriefArgs,
    },
    (args) => ({
      description: `Collect mail for: ${args.brief}`,
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: renderCollectForBrief(args, {
              maxCollectMessages: deps.config.limits.maxCollectMessages,
              maxRangeDays: deps.config.limits.maxRangeDays,
            }),
          },
        },
      ],
    }),
  );
}
