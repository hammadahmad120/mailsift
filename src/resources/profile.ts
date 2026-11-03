import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ServerDeps } from '../server.js';
import { withMailboxOrThrow } from '../tools/with-mailbox.js';

/**
 * `mail://profile`: the same JSON `get_mailbox_profile` returns, as a resource (brief section 12).
 * A client can show "which mailbox is this" or hand the model the profile as context without a tool call.
 * Reads run the same credentials -> scope check -> provider path as every tool.
 */
export const PROFILE_URI = 'mail://profile';

export function registerProfileResource(server: McpServer, deps: ServerDeps): void {
  server.registerResource(
    'profile',
    PROFILE_URI,
    {
      title: 'Mailbox profile',
      description:
        'The connected mailbox: email address, message and thread counts, provider, granted scopes, read_only: true. ' +
        'Same data as the get_mailbox_profile tool.',
      mimeType: 'application/json',
    },
    (uri, extra) =>
      withMailboxOrThrow(deps, 'resource:profile', extra, async (provider) => {
        const profile = await provider.getProfile();
        return {
          contents: [
            { uri: uri.href, mimeType: 'application/json', text: JSON.stringify(profile) },
          ],
        };
      }),
  );
}
