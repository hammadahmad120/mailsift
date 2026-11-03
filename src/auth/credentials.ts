import { MailError } from '../errors.js';
import type { ProviderName } from '../providers/types.js';
import { headerValue, type HeaderMap } from './headers.js';

/**
 * The ONLY place credentials enter the server. Strict by transport (decision 2026-11-02):
 *
 * HTTP (the SDK's `extra.requestInfo` is present): credentials come ONLY from the request headers.
 *   - X-Mail-Token: the provider access token, used for this request and forgotten
 *   - X-Mail-Provider: which adapter, default gmail
 *   A missing X-Mail-Token is AUTH_MISSING_TOKEN even when the env holds a token, so a shared
 *   deployment can never fall back to the operator's mailbox for a caller that forgot the header.
 *
 * stdio (no `requestInfo`): credentials come from env. These five variables are stdio ONLY:
 *   MAIL_PROVIDER, MAIL_TOKEN, GMAIL_REFRESH_TOKEN, GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET.
 *   A stdio client launches the server as a child process and has no headers to put them in.
 *   - MAIL_TOKEN is used as-is, or
 *   - GMAIL_REFRESH_TOKEN + GMAIL_CLIENT_ID + GMAIL_CLIENT_SECRET mint an access
 *     token from Google and cache it in memory until shortly before it expires.
 *   An HTTP deployment can leave all five unset.
 *
 * Tokens are returned to the caller for one request and never stored anywhere
 * except the in-memory refresh cache below, which only the env path uses.
 */

export const MAIL_TOKEN_HEADER = 'x-mail-token';
export const MAIL_PROVIDER_HEADER = 'x-mail-provider';

export interface Credentials {
  provider: ProviderName;
  token: string;
}

/** The slice of the SDK's handler `extra` we care about. */
export interface RequestContext {
  /** JSON-RPC id of the tool call, logged as `rpc_id` so one tool line can be matched to one client message. */
  requestId?: string | number;
  /** Present only when the call arrived over HTTP. Its presence selects the header path. */
  requestInfo?: {
    headers?: HeaderMap;
  };
}

/** True when the call came over HTTP: the SDK attaches `requestInfo` only on that transport. */
export function isHttpRequest(extra: RequestContext | undefined): boolean {
  return extra?.requestInfo !== undefined;
}

/**
 * The HTTP branch: pure, reads the two mail headers and nothing else.
 * Exported so the HTTP layer and tests can exercise it without a resolver.
 */
export function credentialsFromHeaders(headers: HeaderMap): Credentials {
  const token = headerValue(headers, MAIL_TOKEN_HEADER);
  if (token === undefined) {
    throw new MailError(
      'AUTH_MISSING_TOKEN',
      'No mail token sent with the request.',
      'Send the mailbox access token in the X-Mail-Token header (and X-Mail-Provider, default gmail). ' +
        'Over HTTP the server never reads mail credentials from its own environment.',
    );
  }
  const provider = parseProvider(headerValue(headers, MAIL_PROVIDER_HEADER));
  return { provider, token };
}

export type CredentialResolver = (extra?: RequestContext) => Promise<Credentials>;

export interface ResolverOptions {
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  now?: () => number;
}

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
/** Refresh this many ms before Google says the token expires. */
const EXPIRY_MARGIN_MS = 60_000;

interface CachedToken {
  token: string;
  expiresAt: number;
}

export function createCredentialResolver(options: ResolverOptions = {}): CredentialResolver {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetch ?? fetch;
  const now = options.now ?? Date.now;

  const provider = parseProvider(env['MAIL_PROVIDER']);
  let cached: CachedToken | null = null;

  return async (extra?: RequestContext): Promise<Credentials> => {
    if (isHttpRequest(extra)) {
      return credentialsFromHeaders(extra?.requestInfo?.headers ?? {});
    }

    // stdio path from here on. Nothing below runs for an HTTP call.
    const direct = nonEmpty(env['MAIL_TOKEN']);
    if (direct) return { provider, token: direct };

    const refreshToken = nonEmpty(env['GMAIL_REFRESH_TOKEN']);
    const clientId = nonEmpty(env['GMAIL_CLIENT_ID']);
    const clientSecret = nonEmpty(env['GMAIL_CLIENT_SECRET']);

    if (!refreshToken || !clientId || !clientSecret) {
      throw new MailError(
        'AUTH_MISSING_TOKEN',
        'No mail token configured.',
        'Set MAIL_TOKEN, or set GMAIL_REFRESH_TOKEN, GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET.',
      );
    }

    if (cached && cached.expiresAt > now()) {
      return { provider, token: cached.token };
    }

    cached = await mintAccessToken({ refreshToken, clientId, clientSecret }, fetchImpl, now);
    return { provider, token: cached.token };
  };
}

function parseProvider(value: string | undefined): ProviderName {
  const v = nonEmpty(value) ?? 'gmail';
  if (v !== 'gmail') {
    throw new MailError('PROVIDER_ERROR', `Unsupported mail provider "${v}".`);
  }
  return v;
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

interface RefreshInput {
  refreshToken: string;
  clientId: string;
  clientSecret: string;
}

async function mintAccessToken(
  input: RefreshInput,
  fetchImpl: typeof fetch,
  now: () => number,
): Promise<CachedToken> {
  let response: Response;
  try {
    response = await fetchImpl(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: input.refreshToken,
        client_id: input.clientId,
        client_secret: input.clientSecret,
      }),
    });
  } catch {
    throw new MailError('PROVIDER_ERROR', 'Could not reach Google to refresh the access token.');
  }

  if (!response.ok) {
    // 400 invalid_grant = refresh token revoked or expired; 401 = bad client credentials.
    throw new MailError(
      'AUTH_TOKEN_INVALID',
      `Google refused to refresh the access token (HTTP ${response.status}).`,
      'Reconnect the mailbox to obtain a new refresh token, and check GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET.',
    );
  }

  const data = (await response.json()) as { access_token?: unknown; expires_in?: unknown };
  if (typeof data.access_token !== 'string' || data.access_token.length === 0) {
    throw new MailError('PROVIDER_ERROR', 'Google token response had no access_token.');
  }
  const expiresInSec = typeof data.expires_in === 'number' ? data.expires_in : 3600;

  return {
    token: data.access_token,
    expiresAt: now() + expiresInSec * 1000 - EXPIRY_MARGIN_MS,
  };
}
