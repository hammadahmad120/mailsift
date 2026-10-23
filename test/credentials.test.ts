import { describe, expect, it, vi } from 'vitest';
import { createCredentialResolver } from '../src/auth/credentials.js';
import { MailError } from '../src/errors.js';

function tokenResponse(token: string, expiresIn = 3600): Response {
  return new Response(JSON.stringify({ access_token: token, expires_in: expiresIn }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

const refreshEnv = {
  GMAIL_REFRESH_TOKEN: '1//refresh',
  GMAIL_CLIENT_ID: 'id.apps.googleusercontent.com',
  GMAIL_CLIENT_SECRET: 'GOCSPX-secret',
};

describe('createCredentialResolver (env / stdio)', () => {
  it('returns MAIL_TOKEN directly and defaults provider to gmail', async () => {
    const fetchMock = vi.fn();
    const resolve = createCredentialResolver({
      env: { MAIL_TOKEN: 'ya29.direct' },
      fetch: fetchMock,
    });

    await expect(resolve()).resolves.toEqual({ provider: 'gmail', token: 'ya29.direct' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('throws AUTH_MISSING_TOKEN when nothing is configured', async () => {
    const resolve = createCredentialResolver({ env: {} });
    const err = await resolve().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MailError);
    expect((err as MailError).code).toBe('AUTH_MISSING_TOKEN');
  });

  it('throws AUTH_MISSING_TOKEN when the refresh trio is incomplete', async () => {
    const resolve = createCredentialResolver({
      env: { GMAIL_REFRESH_TOKEN: '1//refresh', GMAIL_CLIENT_ID: 'id' },
    });
    await expect(resolve()).rejects.toMatchObject({ code: 'AUTH_MISSING_TOKEN' });
  });

  it('rejects an unsupported provider at creation', () => {
    expect(() =>
      createCredentialResolver({ env: { MAIL_PROVIDER: 'outlook', MAIL_TOKEN: 'x' } }),
    ).toThrow(/Unsupported mail provider/);
  });

  it('mints an access token from the refresh trio', async () => {
    const fetchMock = vi.fn().mockResolvedValue(tokenResponse('ya29.minted'));
    const resolve = createCredentialResolver({ env: refreshEnv, fetch: fetchMock });

    await expect(resolve()).resolves.toEqual({ provider: 'gmail', token: 'ya29.minted' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://oauth2.googleapis.com/token');
    expect(init.method).toBe('POST');
    const body = init.body as URLSearchParams;
    expect(body.get('grant_type')).toBe('refresh_token');
    expect(body.get('refresh_token')).toBe('1//refresh');
    expect(body.get('client_id')).toBe('id.apps.googleusercontent.com');
    expect(body.get('client_secret')).toBe('GOCSPX-secret');
  });

  it('caches the minted token and re-mints only after it nears expiry', async () => {
    let clock = 1_000_000;
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(tokenResponse('ya29.first', 3600))
      .mockResolvedValueOnce(tokenResponse('ya29.second', 3600));
    const resolve = createCredentialResolver({
      env: refreshEnv,
      fetch: fetchMock,
      now: () => clock,
    });

    expect((await resolve()).token).toBe('ya29.first');
    clock += 30 * 60 * 1000; // 30 min later: still valid
    expect((await resolve()).token).toBe('ya29.first');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    clock += 29.5 * 60 * 1000; // 59.5 min total: inside the 60s safety margin
    expect((await resolve()).token).toBe('ya29.second');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('maps a refused refresh to AUTH_TOKEN_INVALID', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 }));
    const resolve = createCredentialResolver({ env: refreshEnv, fetch: fetchMock });

    await expect(resolve()).rejects.toMatchObject({ code: 'AUTH_TOKEN_INVALID' });
  });

  it('maps a network failure to PROVIDER_ERROR without leaking details', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('ECONNREFUSED 1//refresh'));
    const resolve = createCredentialResolver({ env: refreshEnv, fetch: fetchMock });

    const err = (await resolve().catch((e: unknown) => e)) as MailError;
    expect(err.code).toBe('PROVIDER_ERROR');
    expect(err.message).not.toContain('1//refresh');
  });

  it('prefers MAIL_TOKEN over the refresh trio when both are set', async () => {
    const fetchMock = vi.fn();
    const resolve = createCredentialResolver({
      env: { ...refreshEnv, MAIL_TOKEN: 'ya29.direct' },
      fetch: fetchMock,
    });
    expect((await resolve()).token).toBe('ya29.direct');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
