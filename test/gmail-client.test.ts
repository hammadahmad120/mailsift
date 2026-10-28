import { describe, expect, it, vi } from 'vitest';
import {
  createGmailClient,
  isAllowedPath,
  isRetryableStatus,
  retryDelay,
} from '../src/providers/gmail/client.js';
import type { MailError } from '../src/errors.js';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Records every requested sleep and resolves at once, so retries run instantly. */
const makeClient = (fetchMock: typeof fetch, sleeps: number[] = []) =>
  createGmailClient({
    token: 'ya29.test-token',
    timeoutMs: 5000,
    fetch: fetchMock,
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
  });

const codeOf = async (p: Promise<unknown>) =>
  ((await p.catch((e: unknown) => e)) as MailError).code;

describe('allow-list', () => {
  it('allows exactly the five read endpoints', () => {
    for (const ok of [
      'profile',
      'messages',
      'messages/18f3a9c0ffee',
      'threads/18f3a9c0ffee',
      'messages/18f3a9c0ffee/attachments/ANGjdJ8w-_x=',
    ]) {
      expect(isAllowedPath(ok), ok).toBe(true);
    }
  });

  it('refuses every write or unknown path', () => {
    for (const bad of [
      'messages/abc/modify',
      'messages/abc/trash',
      'messages/abc/untrash',
      'messages/send',
      'messages/import',
      'messages/batchDelete',
      'messages/batchModify',
      'messages/insert',
      'messages/18f3a9c0ffee/attachments/send',
      'messages/send/attachments/abc',
      'threads/abc/modify',
      'drafts',
      'labels',
      'settings/filters',
      'profile/extra',
      'messages/',
      'messages/abc/',
      'messages/abc/attachments',
      'messages/a b/attachments/c',
    ]) {
      expect(isAllowedPath(bad), bad).toBe(false);
    }
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
    const fetchMock = vi.fn().mockImplementation(() => json({ error: 'x' }, status));
    expect(await codeOf(makeClient(fetchMock).get('profile'))).toBe(code);
  });

  it('does not retry 401, 403 or 404', async () => {
    for (const status of [401, 403, 404]) {
      const fetchMock = vi.fn().mockImplementation(() => json({ error: 'x' }, status));
      const sleeps: number[] = [];
      await makeClient(fetchMock, sleeps)
        .get('profile')
        .catch(() => undefined);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(sleeps).toEqual([]);
    }
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

  it('retries a 503 and succeeds on the second try', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() => json({ error: 'down' }, 503))
      .mockImplementationOnce(() => json({ emailAddress: 'me@example.com' }));
    const sleeps: number[] = [];

    const result = await makeClient(fetchMock, sleeps).get<{ emailAddress: string }>('profile');

    expect(result.emailAddress).toBe('me@example.com');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleeps).toEqual([500]);
  });

  it('ends as RATE_LIMITED after three 429s with doubling backoff', async () => {
    const fetchMock = vi.fn().mockImplementation(() => json({ error: 'slow down' }, 429));
    const sleeps: number[] = [];

    const err = (await makeClient(fetchMock, sleeps)
      .get('messages')
      .catch((e: unknown) => e)) as MailError;

    expect(err.code).toBe('RATE_LIMITED');
    expect(err.message).toContain('3 tries');
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([500, 1000]);
  });

  it('ends as PROVIDER_ERROR after three 5xx responses', async () => {
    const fetchMock = vi.fn().mockImplementation(() => json({ error: 'x' }, 502));
    expect(await codeOf(makeClient(fetchMock).get('profile'))).toBe('PROVIDER_ERROR');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('honours Retry-After in seconds over the backoff', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(
        () => new Response('{}', { status: 429, headers: { 'retry-after': '2' } }),
      )
      .mockImplementationOnce(() => json({}));
    const sleeps: number[] = [];

    await makeClient(fetchMock, sleeps).get('profile');
    expect(sleeps).toEqual([2000]);
  });

  it('respects maxAttempts', async () => {
    const fetchMock = vi.fn().mockImplementation(() => json({}, 500));
    const client = createGmailClient({
      token: 't',
      timeoutMs: 1000,
      fetch: fetchMock,
      maxAttempts: 1,
      sleep: () => Promise.resolve(),
    });
    await client.get('profile').catch(() => undefined);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('retry helpers', () => {
  it('isRetryableStatus covers 429 and every 5xx only', () => {
    expect(isRetryableStatus(429)).toBe(true);
    expect(isRetryableStatus(500)).toBe(true);
    expect(isRetryableStatus(599)).toBe(true);
    for (const s of [200, 400, 401, 403, 404, 408]) expect(isRetryableStatus(s)).toBe(false);
  });

  it('retryDelay doubles per attempt, uses Retry-After when present, and is capped', () => {
    const plain = new Response('', { status: 503 });
    expect(retryDelay(plain, 1, 500)).toBe(500);
    expect(retryDelay(plain, 2, 500)).toBe(1000);
    expect(retryDelay(plain, 3, 500)).toBe(2000);

    const seconds = new Response('', { status: 429, headers: { 'retry-after': '7' } });
    expect(retryDelay(seconds, 1, 500)).toBe(7000);

    const huge = new Response('', { status: 429, headers: { 'retry-after': '600' } });
    expect(retryDelay(huge, 1, 500)).toBe(30_000);

    const soon = new Date(Date.now() + 5000).toUTCString();
    const dated = new Response('', { status: 429, headers: { 'retry-after': soon } });
    const d = retryDelay(dated, 1, 500);
    expect(d).toBeGreaterThan(3000);
    expect(d).toBeLessThanOrEqual(5000);

    const junk = new Response('', { status: 429, headers: { 'retry-after': 'soon' } });
    expect(retryDelay(junk, 2, 500)).toBe(1000);
  });
});
