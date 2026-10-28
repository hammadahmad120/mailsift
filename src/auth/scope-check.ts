import { createHash } from 'node:crypto';
import { MailError } from '../errors.js';

/**
 * Read-only enforcement, layer 3 (brief section 7).
 *
 * Before any Gmail call, ask Google which scopes are baked into the access token.
 * A token carrying anything outside the allow-list is refused with
 * AUTH_SCOPE_TOO_BROAD, so even a caller who sends a full-access token never
 * reaches the mailbox. Google rejecting the token is AUTH_TOKEN_INVALID.
 *
 * Verdicts are cached in memory for `ttlMs`, keyed by a SHA-256 of the token.
 * The raw token is never a map key and never appears in an error message.
 *
 * Like the refresh-token call in credentials.ts, this talks to Google's OAuth
 * endpoint, not the Gmail API, so it stays outside the GET-only Gmail client.
 */

export const TOKENINFO_URL = 'https://oauth2.googleapis.com/tokeninfo';

/** Scopes a token may carry. Anything else means it could write. */
export const ALLOWED_SCOPES: readonly string[] = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.metadata',
  'https://www.googleapis.com/auth/userinfo.email',
  'openid',
];

export interface ScopeVerdict {
  /** Every scope Google reported, all within the allow-list. */
  scopes: string[];
  /** Account email when Google includes it. */
  email?: string;
}

export type ScopeCheck = (token: string) => Promise<ScopeVerdict>;

export interface ScopeCheckOptions {
  /** How long a verdict is trusted. From config SCOPE_CACHE_TTL_MS. */
  ttlMs: number;
  fetch?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
}

interface CacheEntry {
  expiresAt: number;
  verdict: ScopeVerdict | MailError;
}

/** Keep the cache from growing without bound under HTTP with many tokens. */
const MAX_CACHE_ENTRIES = 1000;

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Pure: which reported scopes are not allowed. Exported for the test and for docs. */
export function disallowedScopes(scopes: readonly string[]): string[] {
  return scopes.filter((scope) => !ALLOWED_SCOPES.includes(scope));
}

export function createScopeCheck(options: ScopeCheckOptions): ScopeCheck {
  const fetchImpl = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const cache = new Map<string, CacheEntry>();

  return async function assertReadOnlyScope(token: string): Promise<ScopeVerdict> {
    if (token.trim() === '') throw new MailError('AUTH_MISSING_TOKEN', 'The mail token is empty.');

    const key = hashToken(token);
    const hit = cache.get(key);
    if (hit && hit.expiresAt > now()) {
      if (hit.verdict instanceof MailError) throw hit.verdict;
      return { ...hit.verdict, scopes: [...hit.verdict.scopes] };
    }
    cache.delete(key);

    const info = await fetchTokenInfo(token, fetchImpl, timeoutMs);
    const scopes = info.scope.split(/\s+/).filter((s) => s !== '');
    const bad = disallowedScopes(scopes);

    // Never trust a verdict longer than the token itself lives.
    const tokenLifeMs = info.expiresInSec !== undefined ? info.expiresInSec * 1000 : Infinity;
    const expiresAt = now() + Math.min(options.ttlMs, tokenLifeMs);

    if (bad.length > 0) {
      const err = new MailError(
        'AUTH_SCOPE_TOO_BROAD',
        `The mail token carries scopes outside the read-only allow-list: ${bad.join(', ')}.`,
      );
      remember(cache, key, { expiresAt, verdict: err });
      throw err;
    }

    const verdict: ScopeVerdict = { scopes };
    if (info.email !== undefined) verdict.email = info.email;
    remember(cache, key, { expiresAt, verdict });
    return { ...verdict, scopes: [...scopes] };
  };
}

function remember(cache: Map<string, CacheEntry>, key: string, entry: CacheEntry): void {
  if (cache.size >= MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, entry);
}

interface TokenInfo {
  scope: string;
  email?: string;
  expiresInSec?: number;
}

async function fetchTokenInfo(
  token: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<TokenInfo> {
  const url = new URL(TOKENINFO_URL);
  url.searchParams.set('access_token', token);

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    if (err instanceof Error && err.name === 'TimeoutError') {
      throw new MailError(
        'PROVIDER_ERROR',
        `Google did not answer the token check within ${timeoutMs} ms.`,
        'Retry.',
      );
    }
    throw new MailError('PROVIDER_ERROR', 'Could not reach Google to check the mail token.');
  }

  if (response.status === 400 || response.status === 401) {
    throw new MailError(
      'AUTH_TOKEN_INVALID',
      'Google does not recognise the mail token (expired, revoked, or malformed).',
    );
  }
  if (!response.ok) {
    throw new MailError(
      'PROVIDER_ERROR',
      `Google token check failed with HTTP ${response.status}.`,
      'Retry in a moment.',
    );
  }

  const data = (await response.json()) as {
    scope?: unknown;
    email?: unknown;
    expires_in?: unknown;
  };
  if (typeof data.scope !== 'string') {
    throw new MailError('AUTH_TOKEN_INVALID', 'Google reported no scopes for the mail token.');
  }

  const info: TokenInfo = { scope: data.scope };
  if (typeof data.email === 'string') info.email = data.email;
  const exp = typeof data.expires_in === 'string' ? Number(data.expires_in) : data.expires_in;
  if (typeof exp === 'number' && Number.isFinite(exp)) info.expiresInSec = exp;
  return info;
}
