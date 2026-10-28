import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ServerDeps } from '../server.js';
import { toolResult } from './result.js';
import { withMailbox } from './with-mailbox.js';

/**
 * `get_mailbox_profile`: the connection-test tool (brief 8.5).
 * No input. Returns who the mailbox belongs to and how big it is.
 *
 * Every tool follows this exact pattern:
 *   1. declare name, description, zod input shape, read-only annotations
 *   2. `withMailbox(deps, extra, fn)`: credentials, scope check, provider, error mapping
 *   3. inside `fn`, call one of the provider's five read methods
 *   4. return `toolResult(json, summary)`
 */
export function registerGetMailboxProfile(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    'get_mailbox_profile',
    {
      title: 'Get mailbox profile',
      description:
        'Connection test. Returns the mailbox email address, total message and thread counts, ' +
        'the provider name, the granted scopes, and read_only: true. Takes no input.',
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    (_args, extra) =>
      withMailbox(deps, extra, async (provider) => {
        const profile = await provider.getProfile();
        return toolResult(
          profile,
          `Connected to ${profile.email_address} via ${profile.provider} (read-only): ` +
            `${profile.messages_total} messages, ${profile.threads_total} threads.`,
        );
      }),
  );
}
