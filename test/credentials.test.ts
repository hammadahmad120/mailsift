import { describe, expect, it, vi } from 'vitest';
import {
  createCredentialResolver,
  credentialsFromHeaders,
  isHttpRequest,
} from '../src/auth/credentials.js';
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

describe('createCredentialResolver (headers / HTTP, strict by transport)', () => {
  const HEADER_TOKEN = 'ya29.from-header';
  const ENV_TOKEN = 'ya29.from-env';
  const http = (headers: Record<string, string | string[] | undefined>) => ({
    requestId: 7,
    requestInfo: { headers },
  });

  it('detects the transport from the presence of requestInfo', () => {
    expect(isHttpRequest(undefined)).toBe(false);
    expect(isHttpRequest({ requestId: 1 })).toBe(false);
    expect(isHttpRequest({ requestInfo: {} })).toBe(true);
    expect(isHttpRequest(http({}))).toBe(true);
  });

  it('returns the X-Mail-Token header and defaults the provider to gmail', async () => {
    const fetchMock = vi.fn();
    const resolve = createCredentialResolver({ env: {}, fetch: fetchMock });

    await expect(resolve(http({ 'x-mail-token': HEADER_TOKEN }))).resolves.toEqual({
      provider: 'gmail',
      token: HEADER_TOKEN,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('honours X-Mail-Provider and refuses an unsupported one per request', async () => {
    const resolve = createCredentialResolver({ env: {} });

    await expect(
      resolve(http({ 'X-Mail-Token': HEADER_TOKEN, 'X-Mail-Provider': 'gmail' })),
    ).resolves.toEqual({ provider: 'gmail', token: HEADER_TOKEN });
    await expect(
      resolve(http({ 'x-mail-token': HEADER_TOKEN, 'x-mail-provider': 'outlook' })),
    ).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
  });

  it('ignores env credentials entirely when the call came over HTTP', async () => {
    const fetchMock = vi.fn();
    const resolve = createCredentialResolver({
      env: { MAIL_TOKEN: ENV_TOKEN, ...refreshEnv },
      fetch: fetchMock,
    });

    // header present: header wins, env never consulted
    await expect(resolve(http({ 'x-mail-token': HEADER_TOKEN }))).resolves.toEqual({
      provider: 'gmail',
      token: HEADER_TOKEN,
    });

    // header missing: structured error, NOT the env token
    const err = await resolve(http({})).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MailError);
    expect((err as MailError).code).toBe('AUTH_MISSING_TOKEN');
    expect((err as MailError).hint).toContain('X-Mail-Token');
    expect(JSON.stringify((err as MailError).toBody())).not.toContain(ENV_TOKEN);
    expect(fetchMock).not.toHaveBeenCalled();

    // the same resolver still serves stdio calls from env
    await expect(resolve()).resolves.toEqual({ provider: 'gmail', token: ENV_TOKEN });
  });

  it('treats a blank or repeated X-Mail-Token as missing', async () => {
    const resolve = createCredentialResolver({ env: { MAIL_TOKEN: ENV_TOKEN } });
    await expect(resolve(http({ 'x-mail-token': '  ' }))).rejects.toMatchObject({
      code: 'AUTH_MISSING_TOKEN',
    });
    await expect(resolve(http({ 'x-mail-token': ['a', 'b'] }))).rejects.toMatchObject({
      code: 'AUTH_MISSING_TOKEN',
    });
  });

  it('never caches a header token: each request is resolved from its own headers', async () => {
    const resolve = createCredentialResolver({ env: {} });
    await expect(resolve(http({ 'x-mail-token': 'ya29.first' }))).resolves.toMatchObject({
      token: 'ya29.first',
    });
    await expect(resolve(http({ 'x-mail-token': 'ya29.second' }))).resolves.toMatchObject({
      token: 'ya29.second',
    });
    await expect(resolve(http({}))).rejects.toMatchObject({ code: 'AUTH_MISSING_TOKEN' });
  });

  it('credentialsFromHeaders is usable on its own', () => {
    expect(credentialsFromHeaders({ 'x-mail-token': HEADER_TOKEN })).toEqual({
      provider: 'gmail',
      token: HEADER_TOKEN,
    });
    expect(() => credentialsFromHeaders({})).toThrow(MailError);
  });
});
