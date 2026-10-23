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

/**
 * Last line of defence against leaking a token through an error message.
 * The full redaction lives in the logger (phase 5); this covers the common shapes.
 */
export function redactSecrets(text: string): string {
  return text
    .replace(/ya29\.[\w.-]+/g, '[redacted]')
    .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/access_token=[^&\s]+/gi, 'access_token=[redacted]');
}

/**
 * Turn anything thrown inside a tool handler into the MCP tool-error reply.
 * Unknown errors become PROVIDER_ERROR with a generic message; their internals never leave the server.
 */
export function toToolError(err: unknown): CallToolResult {
  const body: ToolErrorBody = isMailError(err)
    ? err.toBody()
    : { code: 'PROVIDER_ERROR', message: 'Unexpected error while talking to the mail provider.' };

  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify(body) }],
  };
}
