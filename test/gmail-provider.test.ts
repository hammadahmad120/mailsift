import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { GmailProvider } from '../src/providers/gmail/provider.js';
import type { GmailClient } from '../src/providers/gmail/client.js';

const profileFixture = JSON.parse(
  readFileSync(new URL('./fixtures/gmail/profile.json', import.meta.url), 'utf8'),
) as unknown;

function fakeClient(
  responses: Record<string, unknown>,
): GmailClient & { get: ReturnType<typeof vi.fn> } {
  const get = vi.fn((path: string) => {
    if (path in responses) return Promise.resolve(responses[path]);
    return Promise.reject(new Error(`unexpected path ${path}`));
  });
  return { get } as GmailClient & { get: ReturnType<typeof vi.fn> };
}

describe('GmailProvider.getProfile', () => {
  it('maps the recorded Gmail profile into a MailboxProfile', async () => {
    const client = fakeClient({ profile: profileFixture });
    const provider = new GmailProvider({
      client,
      scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
    });

    const profile = await provider.getProfile();

    expect(profile).toEqual({
      email_address: 'someone@example.com',
      messages_total: 48213,
      threads_total: 31977,
      provider: 'gmail',
      scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
      read_only: true,
    });
    expect(client.get.mock.calls).toEqual([['profile']]);
  });

  it('defaults scopes to an empty list and missing counts to zero', async () => {
    const client = fakeClient({ profile: { emailAddress: 'a@b.c' } });
    const profile = await new GmailProvider({ client }).getProfile();
    expect(profile.scopes).toEqual([]);
    expect(profile.messages_total).toBe(0);
    expect(profile.threads_total).toBe(0);
  });

  it('fails with PROVIDER_ERROR when Google returns no email address', async () => {
    const client = fakeClient({ profile: { messagesTotal: 1 } });
    await expect(new GmailProvider({ client }).getProfile()).rejects.toMatchObject({
      code: 'PROVIDER_ERROR',
    });
  });

  it('exposes exactly the five MailProvider methods', () => {
    const provider = new GmailProvider({ client: fakeClient({}) });
    const methods = Object.getOwnPropertyNames(GmailProvider.prototype).filter(
      (n) => n !== 'constructor',
    );
    expect(methods.sort()).toEqual([
      'getAttachment',
      'getMessage',
      'getProfile',
      'getThread',
      'search',
    ]);
    expect(provider.name).toBe('gmail');
  });

  it('reports the other methods as not implemented yet', async () => {
    const provider = new GmailProvider({ client: fakeClient({}) });
    await expect(provider.search({}, { page_size: 1 })).rejects.toMatchObject({
      code: 'PROVIDER_ERROR',
    });
    await expect(provider.getMessage('x')).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
    await expect(provider.getThread('x')).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
    await expect(provider.getAttachment('x', 'y')).rejects.toMatchObject({
      code: 'PROVIDER_ERROR',
    });
  });
});
