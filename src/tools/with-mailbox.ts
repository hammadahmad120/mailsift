import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { RequestContext } from '../auth/credentials.js';
import { isMailError, toToolError } from '../errors.js';
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
 *   6. one log line: tool, request id, duration, and the error code if any
 *
 * A tool handler is therefore: `withMailbox(deps, 'tool_name', extra, async (provider) => ...)`.
 */
export async function withMailbox(
  deps: ServerDeps,
  tool: string,
  extra: RequestContext | undefined,
  fn: (provider: MailProvider) => Promise<CallToolResult>,
): Promise<CallToolResult> {
  const started = Date.now();
  const fields = { tool, request_id: extra?.requestId };

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
    return toToolError(err);
  }
}
