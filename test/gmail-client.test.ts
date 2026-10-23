import { describe, expect, it, vi } from 'vitest';
import { createGmailClient, isAllowedPath } from '../src/providers/gmail/client.js';
import type { MailError } from '../src/errors.js';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const makeClient = (fetchMock: typeof fetch) =>
  createGmailClient({ token: 'ya29.test-token', timeoutMs: 5000, fetch: fetchMock });

const codeOf = async (p: Promise<unknown>) =>
  ((await p.catch((e: unknown) => e)) as MailError).code;

describe('allow-list', () => {
  it('allows profile only in phase 1', () => {
    expect(isAllowedPath('profile')).toBe(true);
    expect(isAllowedPath('messages')).toBe(false);
    expect(isAllowedPath('messages/abc/modify')).toBe(false);
    expect(isAllowedPath('drafts')).toBe(false);
    expect(isAllowedPath('profile/extra')).toBe(false);
  });
});

describe('createGmailClient', () => {
  it('performs a GET with the bearer token against the Gmail base URL', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ emailAddress: 'me@example.com' }));
    const client = makeClient(fetchMock);

    const result = await client.get<{ emailAddress: string }>('profile');

    expect(result.emailAddress).toBe('me@example.com');
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe('https://gmail.googleapis.com/gmail/v1/users/me/profile');
    expect(init.method).toBe('GET');
    expect((init.headers as Record<string, string>)['authorization']).toBe(
      'Bearer ya29.test-token',
    );
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('appends query params and drops undefined ones', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({}));
    await makeClient(fetchMock).get('profile', { a: 'x y', n: 5, skip: undefined });
    const [url] = fetchMock.mock.calls[0] as [URL];
    expect(url.search).toBe('?a=x+y&n=5');
  });

  it('refuses a path that is not on the allow-list before calling fetch', async () => {
    const fetchMock = vi.fn();
    const client = makeClient(fetchMock);

    await expect(client.get('messages/abc/modify')).rejects.toMatchObject({
      code: 'PROVIDER_ERROR',
      message: expect.stringContaining('allow-list') as string,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses malformed paths that could escape the base URL', async () => {
    const fetchMock = vi.fn();
    const client = makeClient(fetchMock);
    for (const bad of [
      '/profile',
      'profile?x=1',
      '../users/other/profile',
      'https://evil/profile',
    ]) {
      await expect(client.get(bad)).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('has no way to send anything other than GET', () => {
    const client = makeClient(vi.fn());
    expect(Object.keys(client)).toEqual(['get']);
  });

  it.each([
    [401, 'AUTH_TOKEN_INVALID'],
    [403, 'AUTH_TOKEN_INVALID'],
    [404, 'NOT_FOUND'],
    [429, 'RATE_LIMITED'],
    [500, 'PROVIDER_ERROR'],
    [503, 'PROVIDER_ERROR'],
  ])('maps HTTP %i to %s', async (status, code) => {
    const fetchMock = vi.fn().mockResolvedValue(json({ error: 'x' }, status));
    expect(await codeOf(makeClient(fetchMock).get('profile'))).toBe(code);
  });

  it('maps a timeout to PROVIDER_ERROR with a clear message', async () => {
    const timeoutErr = new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    const fetchMock = vi.fn().mockRejectedValue(timeoutErr);
    await expect(makeClient(fetchMock).get('profile')).rejects.toMatchObject({
      code: 'PROVIDER_ERROR',
      message: expect.stringContaining('did not respond') as string,
    });
  });

  it('maps a network failure to PROVIDER_ERROR without leaking the token', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('ECONNRESET Bearer ya29.test-token'));
    const err = (await makeClient(fetchMock)
      .get('profile')
      .catch((e: unknown) => e)) as MailError;
    expect(err.code).toBe('PROVIDER_ERROR');
    expect(err.message).not.toContain('ya29');
  });
});
