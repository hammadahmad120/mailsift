import { MailError } from '../../errors.js';

/**
 * The ONLY module allowed to talk to the Gmail API.
 *
 * Read-only by construction (brief section 7, layer 4):
 *   - GET is the only method. There is no code path for anything else.
 *   - The path must match the allow-list below. Anything else throws before
 *     a request is made.
 *
 * Phase 1 allows `profile` only. Task 2.3 extends the list and adds retries.
 */

export const GMAIL_BASE_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/';

/** Exact paths (relative to GMAIL_BASE_URL) this client may fetch. */
export const ALLOWED_PATHS: readonly RegExp[] = [/^profile$/];

export type QueryParams = Record<string, string | number | undefined>;

export interface GmailClient {
  /** Perform a GET against an allow-listed path and return the parsed JSON body. */
  get<T = unknown>(path: string, query?: QueryParams): Promise<T>;
}

export interface GmailClientOptions {
  token: string;
  timeoutMs: number;
  fetch?: typeof fetch;
}

export function isAllowedPath(path: string): boolean {
  return ALLOWED_PATHS.some((pattern) => pattern.test(path));
}

export function createGmailClient(options: GmailClientOptions): GmailClient {
  const fetchImpl = options.fetch ?? fetch;
  const { token, timeoutMs } = options;

  return {
    async get<T>(path: string, query?: QueryParams): Promise<T> {
      assertSafePath(path);

      const url = new URL(path, GMAIL_BASE_URL);
      for (const [key, value] of Object.entries(query ?? {})) {
        if (value !== undefined) url.searchParams.set(key, String(value));
      }

      let response: Response;
      try {
        response = await fetchImpl(url, {
          method: 'GET',
          headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        if (err instanceof Error && err.name === 'TimeoutError') {
          throw new MailError(
            'PROVIDER_ERROR',
            `Gmail did not respond within ${timeoutMs} ms.`,
            'Retry, or narrow the request.',
          );
        }
        throw new MailError('PROVIDER_ERROR', 'Could not reach the Gmail API.');
      }

      if (!response.ok) throw mapHttpError(response.status, path);

      return (await response.json()) as T;
    },
  };
}

function assertSafePath(path: string): void {
  if (path.startsWith('/') || path.includes('?') || path.includes('..') || path.includes('://')) {
    throw new MailError('PROVIDER_ERROR', `Malformed Gmail API path "${path}".`);
  }
  if (!isAllowedPath(path)) {
    throw new MailError(
      'PROVIDER_ERROR',
      `Gmail API path "${path}" is not on the read-only allow-list.`,
    );
  }
}

function mapHttpError(status: number, path: string): MailError {
  switch (status) {
    case 401:
      return new MailError('AUTH_TOKEN_INVALID', 'Google rejected the mailbox token.');
    case 403:
      return new MailError(
        'AUTH_TOKEN_INVALID',
        'Google refused access with this token.',
        'Check that the token has the gmail.readonly scope and the Gmail API is enabled.',
      );
    case 404:
      return new MailError('NOT_FOUND', `Gmail resource not found: ${path}.`);
    case 429:
      return new MailError('RATE_LIMITED', 'Gmail rate limit hit.');
    default:
      return new MailError('PROVIDER_ERROR', `Gmail API returned HTTP ${status}.`);
  }
}
