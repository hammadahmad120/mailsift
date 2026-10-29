import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config.js';

describe('loadConfig', () => {
  it('applies the defaults from the brief when the environment is empty', () => {
    const config = loadConfig({});

    expect(config.limits).toEqual({
      maxRangeDays: 365,
      maxPageSize: 100,
      maxCollectMessages: 200,
      maxSearchIds: 2000,
      maxAttachmentBytes: 10_485_760,
      maxMessageChars: 50_000,
      maxAttachmentChars: 100_000,
      maxTotalChars: 2_000_000,
      fetchConcurrency: 5,
      gmailTimeoutMs: 20_000,
      scopeCacheTtlMs: 600_000,
    });
    expect(config.provider).toBe('gmail');
    expect(config.http.port).toBe(3000);
    expect(config.http.serverKeys).toEqual([]);
  });

  it('applies overrides from the environment', () => {
    const config = loadConfig({
      MAX_RANGE_DAYS: '30',
      MAX_PAGE_SIZE: '10',
      FETCH_CONCURRENCY: '2',
      PORT: '8080',
    });

    expect(config.limits.maxRangeDays).toBe(30);
    expect(config.limits.maxPageSize).toBe(10);
    expect(config.limits.fetchConcurrency).toBe(2);
    expect(config.http.port).toBe(8080);
    // untouched values keep their defaults
    expect(config.limits.maxCollectMessages).toBe(200);
  });

  it('parses comma-separated server keys and ignores blanks', () => {
    const config = loadConfig({ MCP_SERVER_KEYS: ' key-one, key-two ,, ' });
    expect(config.http.serverKeys).toEqual(['key-one', 'key-two']);
  });

  it('treats an empty MCP_SERVER_KEYS as no keys', () => {
    expect(loadConfig({ MCP_SERVER_KEYS: '' }).http.serverKeys).toEqual([]);
    expect(loadConfig({ MCP_SERVER_KEYS: '   ' }).http.serverKeys).toEqual([]);
  });

  it('throws a ConfigError naming the variable when a limit is not a number', () => {
    expect(() => loadConfig({ MAX_PAGE_SIZE: 'abc' })).toThrow(ConfigError);
    expect(() => loadConfig({ MAX_PAGE_SIZE: 'abc' })).toThrow(/MAX_PAGE_SIZE/);
  });

  it('rejects zero, negative and fractional limits', () => {
    expect(() => loadConfig({ MAX_RANGE_DAYS: '0' })).toThrow(/MAX_RANGE_DAYS/);
    expect(() => loadConfig({ FETCH_CONCURRENCY: '-1' })).toThrow(/FETCH_CONCURRENCY/);
    expect(() => loadConfig({ MAX_TOTAL_CHARS: '1.5' })).toThrow(/MAX_TOTAL_CHARS/);
  });

  it('rejects an unknown provider', () => {
    expect(() => loadConfig({ MAIL_PROVIDER: 'outlook' })).toThrow(/MAIL_PROVIDER/);
  });

  it('does not expose secrets on the config object', () => {
    const config = loadConfig({
      MAIL_TOKEN: 'ya29.secret-access-token',
      GMAIL_REFRESH_TOKEN: '1//secret-refresh',
      GMAIL_CLIENT_SECRET: 'GOCSPX-secret',
      GMAIL_CLIENT_ID: 'id.apps.googleusercontent.com',
    });

    const serialized = JSON.stringify(config);
    expect(serialized).not.toContain('secret');
    expect(serialized).not.toContain('ya29');
    expect(serialized).not.toContain('GOCSPX');
  });

  it('returns a frozen object', () => {
    const config = loadConfig({});
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.limits)).toBe(true);
    expect(Object.isFrozen(config.http)).toBe(true);
    expect(Object.isFrozen(config.http.serverKeys)).toBe(true);
  });
});
