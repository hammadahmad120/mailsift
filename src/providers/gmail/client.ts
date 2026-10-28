import { MailError } from '../../errors.js';

/**
 * The ONLY module allowed to talk to the Gmail API.
 *
 * Read-only by construction (brief section 7, layer 4):
 *   - GET is the only method. There is no code path for anything else.
 *   - The path must match the allow-list below. Anything else throws before
 *     a request is made.
 *
 * Retries (brief section 8.4): 429 and 5xx are retried with backoff, at most
 * `maxAttempts` tries, honouring `Retry-After`. Every caller gets this for free.
 */

export const GMAIL_BASE_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/';

/** A Gmail message, thread or attachment id: URL-safe characters only. */
const ID = '[A-Za-z0-9_=-]+';

/** Exact paths (relative to GMAIL_BASE_URL) this client may fetch. All reads. */
export const ALLOWED_PATHS: readonly RegExp[] = [
  /^profile$/,
  /^messages$/,
  new RegExp(`^messages/${ID}$`),
  new RegExp(`^threads/${ID}$`),
  new RegExp(`^messages/${ID}/attachments/${ID}$`),
];

export type QueryParams = Record<string, string | number | undefined>;

export interface GmailClient {
  /** Perform a GET against an allow-listed path and return the parsed JSON body. */
  get<T = unknown>(path: string, query?: QueryParams): Promise<T>;
}

export interface GmailClientOptions {
  token: string;
  timeoutMs: number;
  fetch?: typeof fetch;
  /** Total tries per request, including the first. Default 3. */
  maxAttempts?: number;
  /** First backoff wait; doubles each retry. Default 500 ms. */
  baseDelayMs?: number;
  /** Injected for tests. Defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
}

/** Longest wait between two tries, even if Retry-After asks for more. */
const MAX_DELAY_MS = 30_000;

/**
 * Gmail's write verbs sit where an id would be (`messages/send`, `messages/batchDelete`).
 * They only answer to POST, which this client cannot send, but they are refused by
 * name as well so the allow-list reads as what it is: ids only.
 */
export const RESERVED_SEGMENTS: ReadonlySet<string> = new Set([
  'send',
  'import',
  'insert',
  'batchDelete',
  'batchModify',
  'modify',
  'trash',
  'untrash',
  'delete',
  'attachments',
]);

export function isAllowedPath(path: string): boolean {
  if (!ALLOWED_PATHS.some((pattern) => pattern.test(path))) return false;
  return path
    .split('/')
    .slice(1)
    .every((segment, i, segs) => {
      // `attachments` is a literal in the attachment path, allowed only at its own position.
      if (segment === 'attachments' && i === 1 && segs.length === 3) return true;
      return !RESERVED_SEGMENTS.has(segment);
    });
}

export function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

export function createGmailClient(options: GmailClientOptions): GmailClient {
  const fetchImpl = options.fetch ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  const maxAttempts = Math.max(1, options.maxAttempts ?? 3);
  const baseDelayMs = options.baseDelayMs ?? 500;
  const { token, timeoutMs } = options;

  return {
    async get<T>(path: string, query?: QueryParams): Promise<T> {
      assertSafePath(path);

      const url = new URL(path, GMAIL_BASE_URL);
      for (const [key, value] of Object.entries(query ?? {})) {
        if (value !== undefined) url.searchParams.set(key, String(value));
      }

      for (let attempt = 1; ; attempt++) {
        const response = await fetchOnce(url);

        if (response.ok) return (await response.json()) as T;

        const retriesLeft = attempt < maxAttempts;
        if (!retriesLeft || !isRetryableStatus(response.status)) {
          throw mapHttpError(response.status, path, attempt);
        }

        await sleep(retryDelay(response, attempt, baseDelayMs));
      }
    },
  };

  async function fetchOnce(url: URL): Promise<Response> {
    try {
      return await fetchImpl(url, {
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
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Retry-After (seconds or HTTP date) wins; otherwise exponential backoff. Capped. */
export function retryDelay(response: Response, attempt: number, baseDelayMs: number): number {
  const header = response.headers.get('retry-after');
  let delay = baseDelayMs * 2 ** (attempt - 1);

  if (header !== null) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) {
      delay = seconds * 1000;
    } else {
      const at = Date.parse(header);
      if (!Number.isNaN(at)) delay = Math.max(0, at - Date.now());
    }
  }

  return Math.min(delay, MAX_DELAY_MS);
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

function mapHttpError(status: number, path: string, attempts: number): MailError {
  const tried = attempts > 1 ? ` after ${attempts} tries` : '';
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
      return new MailError('RATE_LIMITED', `Gmail rate limit hit${tried}.`);
    default:
      return new MailError('PROVIDER_ERROR', `Gmail API returned HTTP ${status}${tried}.`);
  }
}
