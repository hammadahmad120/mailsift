import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { RequestContext } from '../auth/credentials.js';
import { toToolError } from '../errors.js';
import type { MailProvider } from '../providers/types.js';
import type { ServerDeps } from '../server.js';

/**
 * The per-call sequence every tool runs, in one place so no tool can skip a step:
 *
 *   1. resolve credentials (env now, headers in phase 5)
 *   2. scope check: refuse any token that could write (brief section 7, layer 3)
 *   3. build a provider for this call only, carrying the verified scopes
 *   4. run the tool's own logic
 *   5. any throw becomes a structured `{ code, message, hint }` tool error
 *
 * A tool handler is therefore: `withMailbox(deps, extra, async (provider) => ...)`.
 */
export async function withMailbox(
  deps: ServerDeps,
  extra: RequestContext | undefined,
  fn: (provider: MailProvider) => Promise<CallToolResult>,
): Promise<CallToolResult> {
  try {
    const credentials = await deps.resolveCredentials(extra);
    const verdict = await deps.checkScope(credentials.token);
    const provider = deps.createProvider(credentials, verdict.scopes);
    return await fn(provider);
  } catch (err) {
    return toToolError(err);
  }
}
