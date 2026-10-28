import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CredentialResolver, Credentials } from './auth/credentials.js';
import { createCredentialResolver } from './auth/credentials.js';
import type { Config } from './config.js';
import { loadConfig } from './config.js';
import { createGmailClient } from './providers/gmail/client.js';
import { GmailProvider } from './providers/gmail/provider.js';
import type { MailProvider } from './providers/types.js';
import { registerGetMailboxProfile } from './tools/get-mailbox-profile.js';
import { registerSearchMail } from './tools/search-mail.js';

/** Must match package.json. Bumped on release (task 6.5). */
export const SERVER_INFO = { name: 'mailsift', version: '0.1.0' } as const;

/**
 * Everything a tool handler needs, injected so tests can swap in fakes.
 * Both transports call `createServer(createDefaultDeps())`; only the transport differs.
 */
export interface ServerDeps {
  config: Config;
  /** The one place credentials enter the server. */
  resolveCredentials: CredentialResolver;
  /** Builds a provider for one request. Credentials live only as long as the call. */
  createProvider: (credentials: Credentials) => MailProvider;
}

/** Production wiring: env config, env credentials, Gmail through the locked client. */
export function createDefaultDeps(env: NodeJS.ProcessEnv = process.env): ServerDeps {
  const config = loadConfig(env);
  return {
    config,
    resolveCredentials: createCredentialResolver({ env }),
    createProvider: (credentials) =>
      new GmailProvider({
        client: createGmailClient({
          token: credentials.token,
          timeoutMs: config.limits.gmailTimeoutMs,
        }),
        maxRangeDays: config.limits.maxRangeDays,
      }),
  };
}

/** Builds the McpServer and registers every tool, resource and prompt. */
export function createServer(deps: ServerDeps): McpServer {
  const server = new McpServer(SERVER_INFO, {
    instructions:
      'Read-only mailbox access. Use get_mailbox_profile to confirm the connection, ' +
      'then search_mail to find messages by subject, sender, dates, keywords or attachments. ' +
      'No tool can send, modify, label, or delete mail.',
  });

  registerGetMailboxProfile(server, deps);
  registerSearchMail(server, deps);

  return server;
}
