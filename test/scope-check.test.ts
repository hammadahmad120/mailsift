import { describe, expect, it, vi } from 'vitest';
import {
  ALLOWED_SCOPES,
  TOKENINFO_URL,
  createScopeCheck,
  disallowedScopes,
  hashToken,
} from '../src/auth/scope-check.js';
import { MailError } from '../src/errors.js';

const READONLY = 'https://www.googleapis.com/auth/gmail.readonly';
const MODIFY = 'https://www.googleapis.com/auth/gmail.modify';
const TOKEN = 'ya29.test-token';

function tokenInfo(scope: string, extra: Record<string, unknown> = {}): Response {
  return new Response(JSON.stringify({ scope, expires_in: '3599', ...extra }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function invalidToken(): Response {
  return new Response(JSON.stringify({ error: 'invalid_token' }), { status: 400 });
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  const err = await promise.catch((e: unknown) => e);
  expect(err).toBeInstanceOf(MailError);
  return (err as MailError).code;
}

describe('disallowedScopes', () => {
  it('accepts every allow-listed scope and nothing else', () => {
    expect(disallowedScopes([...ALLOWED_SCOPES])).toEqual([]);
    expect(disallowedScopes([READONLY, MODIFY, 'openid'])).toEqual([MODIFY]);
  });
});

describe('createScopeCheck', () => {
  it('passes a read-only token and returns its scopes and email', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(tokenInfo(`${READONLY} openid`, { email: 'a@b.c' }));
    const check = createScopeCheck({ ttlMs: 600_000, fetch: fetchMock });

    await expect(check(TOKEN)).resolves.toEqual({ scopes: [READONLY, 'openid'], email: 'a@b.c' });

    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.origin + url.pathname).toBe(TOKENINFO_URL);
    expect(url.searchParams.get('access_token')).toBe(TOKEN);
    expect(init.method).toBe('GET');
  });

  it('rejects gmail.modify with AUTH_SCOPE_TOO_BROAD and names the offending scope only', async () => {
    const fetchMock = vi.fn().mockImplementation(() => tokenInfo(`${READONLY} ${MODIFY}`));
    const check = createScopeCheck({ ttlMs: 600_000, fetch: fetchMock });

    const err = (await check(TOKEN).catch((e: unknown) => e)) as MailError;
    expect(err.code).toBe('AUTH_SCOPE_TOO_BROAD');
    expect(err.message).toContain(MODIFY);
    expect(err.message).not.toContain(TOKEN);
    expect(err.hint).toMatch(/read-only/);
  });

  it('rejects a token Google does not recognise with AUTH_TOKEN_INVALID', async () => {
    const check = createScopeCheck({
      ttlMs: 600_000,
      fetch: vi.fn().mockImplementation(() => invalidToken()),
    });
    expect(await codeOf(check(TOKEN))).toBe('AUTH_TOKEN_INVALID');
  });

  it('rejects an empty token without calling Google', async () => {
    const fetchMock = vi.fn();
    const check = createScopeCheck({ ttlMs: 600_000, fetch: fetchMock });
    expect(await codeOf(check('   '))).toBe('AUTH_MISSING_TOKEN');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('maps network failure and non-auth HTTP errors to PROVIDER_ERROR', async () => {
    const down = createScopeCheck({
      ttlMs: 1,
      fetch: vi.fn().mockRejectedValue(new Error('ECONNRESET')),
    });
    expect(await codeOf(down(TOKEN))).toBe('PROVIDER_ERROR');

    const flaky = createScopeCheck({
      ttlMs: 1,
      fetch: vi.fn().mockImplementation(() => new Response('oops', { status: 503 })),
    });
    expect(await codeOf(flaky(TOKEN))).toBe('PROVIDER_ERROR');
  });

  it('does not hit fetch again within the TTL', async () => {
    let t = 1_000_000;
    const fetchMock = vi.fn().mockImplementation(() => tokenInfo(READONLY));
    const check = createScopeCheck({ ttlMs: 600_000, fetch: fetchMock, now: () => t });

    await check(TOKEN);
    t += 599_000;
    await check(TOKEN);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    t += 2_000;
    await check(TOKEN);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('caches a too-broad verdict as well', async () => {
    const fetchMock = vi.fn().mockImplementation(() => tokenInfo(MODIFY));
    const check = createScopeCheck({ ttlMs: 600_000, fetch: fetchMock });

    expect(await codeOf(check(TOKEN))).toBe('AUTH_SCOPE_TOO_BROAD');
    expect(await codeOf(check(TOKEN))).toBe('AUTH_SCOPE_TOO_BROAD');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not cache an invalid-token or provider error', async () => {
    const fetchMock = vi.fn().mockImplementation(() => invalidToken());
    const check = createScopeCheck({ ttlMs: 600_000, fetch: fetchMock });

    await check(TOKEN).catch(() => undefined);
    await check(TOKEN).catch(() => undefined);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('trusts a verdict no longer than the token lives', async () => {
    let t = 1_000_000;
    const fetchMock = vi.fn().mockImplementation(() => tokenInfo(READONLY, { expires_in: '60' }));
    const check = createScopeCheck({ ttlMs: 600_000, fetch: fetchMock, now: () => t });

    await check(TOKEN);
    t += 61_000;
    await check(TOKEN);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('keeps separate verdicts per token', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() => tokenInfo(READONLY))
      .mockImplementationOnce(() => tokenInfo(MODIFY));
    const check = createScopeCheck({ ttlMs: 600_000, fetch: fetchMock });

    await expect(check('ya29.one')).resolves.toMatchObject({ scopes: [READONLY] });
    expect(await codeOf(check('ya29.two'))).toBe('AUTH_SCOPE_TOO_BROAD');
  });

  it('keys the cache by a SHA-256 hash, never the raw token', () => {
    const key = hashToken(TOKEN);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(key).not.toContain(TOKEN);
    expect(hashToken(TOKEN)).toBe(key);
    expect(hashToken('ya29.other')).not.toBe(key);
  });

  it('returns a fresh scopes array on each call so callers cannot mutate the cache', async () => {
    const check = createScopeCheck({
      ttlMs: 600_000,
      fetch: vi.fn().mockImplementation(() => tokenInfo(READONLY)),
    });
    const first = await check(TOKEN);
    first.scopes.push(MODIFY);
    const second = await check(TOKEN);
    expect(second.scopes).toEqual([READONLY]);
  });
});
