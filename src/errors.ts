import { ErrorCode as RpcErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

/** Error codes from the design brief, section 10. */
export const ERROR_CODES = [
  'AUTH_MISSING_TOKEN',
  'AUTH_TOKEN_INVALID',
  'AUTH_SCOPE_TOO_BROAD',
  'AUTH_SERVER_KEY',
  'QUERY_EMPTY',
  'RANGE_TOO_WIDE',
  'NOT_FOUND',
  'ATTACHMENT_UNSUPPORTED',
  'RATE_LIMITED',
  'PROVIDER_ERROR',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/** Default hint per code. Tells a model what to do next. */
const DEFAULT_HINTS: Record<ErrorCode, string | undefined> = {
  AUTH_MISSING_TOKEN: 'Connect a mailbox and retry.',
  AUTH_TOKEN_INVALID: 'The mailbox token expired or was revoked. Refresh it and retry.',
  AUTH_SCOPE_TOO_BROAD: 'Reconnect the mailbox with read-only access only.',
  AUTH_SERVER_KEY: 'Send a valid server key in the Authorization header.',
  QUERY_EMPTY: 'Give at least one of subject, from, to, keywords, dates, or raw_query.',
  RANGE_TOO_WIDE: 'Narrow the date range.',
  NOT_FOUND: 'Check the id and retry, or search again to get a fresh id.',
  ATTACHMENT_UNSUPPORTED:
    'Skipped. Supported: pdf, docx, txt, md, csv, html, up to the size limit.',
  RATE_LIMITED: 'Wait a minute and retry with a smaller page_size.',
  PROVIDER_ERROR: undefined,
};

/** The JSON body every tool error carries. */
export interface ToolErrorBody {
  code: ErrorCode;
  message: string;
  hint?: string;
}

export class MailError extends Error {
  override readonly name = 'MailError';
  readonly code: ErrorCode;
  readonly hint: string | undefined;

  constructor(code: ErrorCode, message?: string, hint?: string) {
    super(message ?? code);
    this.code = code;
    this.hint = hint ?? DEFAULT_HINTS[code];
  }

  toBody(): ToolErrorBody {
    const body: ToolErrorBody = { code: this.code, message: redactSecrets(this.message) };
    if (this.hint !== undefined) body.hint = this.hint;
    return body;
  }
}

export function isMailError(err: unknown): err is MailError {
  return err instanceof MailError;
}

/** An `McpError` produced by `toMcpError`, carrying the structured body in `data`. */
function isMcpErrorWithBody(err: unknown): err is McpError & { data: ToolErrorBody } {
  if (!(err instanceof McpError) || typeof err.data !== 'object' || err.data === null) return false;
  const data = err.data as Partial<ToolErrorBody>;
  return typeof data.code === 'string' && typeof data.message === 'string';
}

/**
 * Replaces every known credential shape inside a string.
 * Used on error messages here and on every string the logger writes (`src/logging.ts`).
 *
 * Shapes: Google access tokens (`ya29.`), Google refresh tokens (`1//` plus 20+ chars), Google client
 * secrets (`GOCSPX-`), JWTs (`eyJ...`), `Bearer <anything>`, and `access_token=` or
 * `refresh_token=` query values. Field-name based redaction (`Authorization`, `X-Mail-Token`)
 * is the logger's job, since that needs the key, not just the value.
 */
export function redactSecrets(text: string): string {
  return text
    .replace(/ya29\.[\w.-]+/g, '[redacted]')
    .replace(/\b1\/\/[\w-]{20,}/g, '[redacted]')
    .replace(/\bGOCSPX-[\w-]+/g, '[redacted]')
    .replace(/\beyJ[\w-]+\.[\w-]+\.[\w-]+/g, '[redacted]')
    .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\b(access_token|refresh_token)=[^&\s]+/gi, '$1=[redacted]');
}

/**
 * Turn anything thrown inside a tool handler into the MCP tool-error reply.
 * Unknown errors become PROVIDER_ERROR with a generic message; their internals never leave the server.
 */
export function toToolError(err: unknown): CallToolResult {
  const body: ToolErrorBody = isMailError(err)
    ? err.toBody()
    : isMcpErrorWithBody(err)
      ? err.data
      : { code: 'PROVIDER_ERROR', message: 'Unexpected error while talking to the mail provider.' };

  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify(body) }],
  };
}

/**
 * Resource and prompt handlers have no `isError` result shape: a failure there is a JSON-RPC
 * error. This keeps the brief's `{ code, message, hint }` body in the error's `data` and puts
 * `CODE: message` in the text, so a client still sees the structured error.
 */
export function toMcpError(err: unknown): McpError {
  if (err instanceof McpError) return err;
  const body: ToolErrorBody = isMailError(err)
    ? err.toBody()
    : { code: 'PROVIDER_ERROR', message: 'Unexpected error while talking to the mail provider.' };
  const rpcCode =
    body.code === 'NOT_FOUND' ? RpcErrorCode.InvalidParams : RpcErrorCode.InternalError;
  return new McpError(rpcCode, `${body.code}: ${body.message}`, body);
}
