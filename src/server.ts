import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CredentialResolver, Credentials } from './auth/credentials.js';
import { createCredentialResolver } from './auth/credentials.js';
import type { ScopeCheck } from './auth/scope-check.js';
import { createScopeCheck } from './auth/scope-check.js';
import type { Config } from './config.js';
import { loadConfig } from './config.js';
import { createGmailClient } from './providers/gmail/client.js';
import { GmailProvider } from './providers/gmail/provider.js';
import type { MailProvider } from './providers/types.js';
import { registerGetEmail } from './tools/get-email.js';
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
  /** Refuses tokens with write scopes. Runs before any provider is built. */
  checkScope: ScopeCheck;
  /** Builds a provider for one request, with the verified scopes. Credentials live only as long as the call. */
  createProvider: (credentials: Credentials, scopes: readonly string[]) => MailProvider;
}

/** Production wiring: env config, env credentials, Gmail through the locked client. */
export function createDefaultDeps(env: NodeJS.ProcessEnv = process.env): ServerDeps {
  const config = loadConfig(env);
  return {
    config,
    resolveCredentials: createCredentialResolver({ env }),
    checkScope: createScopeCheck({ ttlMs: config.limits.scopeCacheTtlMs }),
    createProvider: (credentials, scopes) =>
      new GmailProvider({
        client: createGmailClient({
          token: credentials.token,
          timeoutMs: config.limits.gmailTimeoutMs,
        }),
        scopes,
        maxRangeDays: config.limits.maxRangeDays,
      }),
  };
}

/** Builds the McpServer and registers every tool, resource and prompt. */
export function createServer(deps: ServerDeps): McpServer {
  const server = new McpServer(SERVER_INFO, {
    instructions:
      'Read-only mailbox access. Use get_mailbox_profile to confirm the connection, ' +
      'then search_mail to find messages by subject, sender, dates, keywords or attachments, ' +
      'then get_email with a message_id to read one. ' +
      'No tool can send, modify, label, or delete mail.',
  });

  registerGetMailboxProfile(server, deps);
  registerSearchMail(server, deps);
  registerGetEmail(server, deps);

  return server;
}
