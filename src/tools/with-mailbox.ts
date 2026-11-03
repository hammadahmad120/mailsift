import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { RequestContext } from '../auth/credentials.js';
import { isMailError, toMcpError, toToolError } from '../errors.js';
import type { MailProvider } from '../providers/types.js';
import type { ServerDeps } from '../server.js';

/**
 * The per-call sequence every tool, resource and prompt that touches a mailbox runs,
 * in one place so none of them can skip a step:
 *
 *   1. resolve credentials (env over stdio, headers over HTTP)
 *   2. scope check: refuse any token that could write (brief section 7, layer 3)
 *   3. build a provider for this call only, carrying the verified scopes
 *   4. run the handler's own logic
 *   5. one log line: name, JSON-RPC id (`rpc_id`), duration, and the error code if any.
 *      Over HTTP the logger is a per-request child that adds `request_id` on its own.
 *
 * Tools: `withMailbox(deps, 'tool_name', extra, fn)` turns any throw into a structured tool error.
 * Resources: `withMailboxOrThrow(deps, 'resource_name', extra, fn)` rethrows it as an `McpError`,
 * because a resource read has no `isError` result shape.
 */
export async function withMailboxOrThrow<T>(
  deps: ServerDeps,
  name: string,
  extra: RequestContext | undefined,
  fn: (provider: MailProvider) => Promise<T>,
): Promise<T> {
  const started = Date.now();
  const fields = { tool: name, rpc_id: extra?.requestId };

  try {
    const credentials = await deps.resolveCredentials(extra);
    const verdict = await deps.checkScope(credentials.token);
    const provider = deps.createProvider(credentials, verdict.scopes);
    const result = await fn(provider);
    deps.logger.info('tool', { ...fields, duration_ms: Date.now() - started });
    return result;
  } catch (err) {
    const duration_ms = Date.now() - started;
    if (isMailError(err)) {
      deps.logger.warn('tool', { ...fields, duration_ms, code: err.code, message: err.message });
    } else {
      deps.logger.error('tool', { ...fields, duration_ms, code: 'PROVIDER_ERROR', error: err });
    }
    throw toMcpError(err);
  }
}

export async function withMailbox(
  deps: ServerDeps,
  tool: string,
  extra: RequestContext | undefined,
  fn: (provider: MailProvider) => Promise<CallToolResult>,
): Promise<CallToolResult> {
  try {
    return await withMailboxOrThrow(deps, tool, extra, fn);
  } catch (err) {
    return toToolError(err);
  }
}
