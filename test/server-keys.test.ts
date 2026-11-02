import { describe, expect, it } from 'vitest';
import {
  bearerToken,
  createServerKeyCheck,
  requireServerKeys,
  safeEqual,
} from '../src/auth/server-keys.js';
import { ConfigError, loadConfig } from '../src/config.js';
import { MailError } from '../src/errors.js';

const KEY_A = 'a3f1c9d2e8b7a6f5c4d3e2f1a0b9c8d7e6f5a4b3c2d1e0f9a8b7c6d5e4f3a2b1';
const KEY_B = 'second-key-for-rotation';

function codeOf(fn: () => void): string {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(MailError);
    return (err as MailError).code;
  }
  throw new Error('expected a throw');
}

describe('safeEqual', () => {
  it('is true only for identical strings', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'ab')).toBe(false);
    expect(safeEqual('', '')).toBe(true);
    expect(safeEqual('', 'a')).toBe(false);
  });

  it('compares bytes, not code units', () => {
    expect(safeEqual('é', 'é')).toBe(true);
    expect(safeEqual('é', 'e')).toBe(false);
  });
});

describe('bearerToken', () => {
  it('extracts the key from a Bearer header, case-insensitively on the scheme and header name', () => {
    expect(bearerToken({ authorization: `Bearer ${KEY_A}` })).toBe(KEY_A);
    expect(bearerToken({ authorization: `bearer ${KEY_A}` })).toBe(KEY_A);
    expect(bearerToken({ Authorization: `Bearer ${KEY_A}` })).toBe(KEY_A);
    expect(bearerToken({ authorization: `Bearer   ${KEY_A}  ` })).toBe(KEY_A);
  });

  it('returns undefined for a missing header, another scheme, an empty value or a repeated header', () => {
    expect(bearerToken({})).toBeUndefined();
    expect(bearerToken({ authorization: `Basic ${KEY_A}` })).toBeUndefined();
    expect(bearerToken({ authorization: 'Bearer' })).toBeUndefined();
    expect(bearerToken({ authorization: 'Bearer ' })).toBeUndefined();
    expect(bearerToken({ authorization: `Bearer ${KEY_A} extra` })).toBeUndefined();
    expect(bearerToken({ authorization: [`Bearer ${KEY_A}`, `Bearer ${KEY_B}`] })).toBeUndefined();
  });
});

describe('createServerKeyCheck', () => {
  const check = createServerKeyCheck([KEY_A, KEY_B]);

  it('accepts any configured key', () => {
    expect(() => check({ authorization: `Bearer ${KEY_A}` })).not.toThrow();
    expect(() => check({ authorization: `Bearer ${KEY_B}` })).not.toThrow();
    expect(() => check({ Authorization: `Bearer ${KEY_B}` })).not.toThrow();
  });

  it('refuses a wrong key, a prefix of a key, a key with a suffix, and the empty key', () => {
    expect(codeOf(() => check({ authorization: 'Bearer nope' }))).toBe('AUTH_SERVER_KEY');
    expect(codeOf(() => check({ authorization: `Bearer ${KEY_A.slice(0, -1)}` }))).toBe(
      'AUTH_SERVER_KEY',
    );
    expect(codeOf(() => check({ authorization: `Bearer ${KEY_A}x` }))).toBe('AUTH_SERVER_KEY');
    expect(codeOf(() => createServerKeyCheck([''])({ authorization: 'Bearer ' }))).toBe(
      'AUTH_SERVER_KEY',
    );
  });

  it('refuses a missing header and a non-Bearer scheme', () => {
    expect(codeOf(() => check({}))).toBe('AUTH_SERVER_KEY');
    expect(codeOf(() => check({ authorization: `Basic ${KEY_A}` }))).toBe('AUTH_SERVER_KEY');
    expect(codeOf(() => check({ 'x-mail-token': KEY_A }))).toBe('AUTH_SERVER_KEY');
  });

  it('refuses everything when no keys are configured', () => {
    const none = createServerKeyCheck([]);
    expect(codeOf(() => none({ authorization: `Bearer ${KEY_A}` }))).toBe('AUTH_SERVER_KEY');
    expect(codeOf(() => none({ authorization: 'Bearer ' }))).toBe('AUTH_SERVER_KEY');
  });

  it('never echoes the presented value in the error', () => {
    let caught: MailError | undefined;
    try {
      check({ authorization: 'Bearer secret-guess-123' });
    } catch (err) {
      caught = err as MailError;
    }
    expect(caught?.message).not.toContain('secret-guess-123');
    expect(JSON.stringify(caught?.toBody())).not.toContain('secret-guess-123');
    expect(caught?.hint).toBe('Send a valid server key in the Authorization header.');
  });
});

describe('requireServerKeys', () => {
  it('returns the parsed keys when at least one is set', () => {
    const config = loadConfig({ MCP_SERVER_KEYS: `${KEY_A}, ${KEY_B}` });
    expect(requireServerKeys(config)).toEqual([KEY_A, KEY_B]);
  });

  it('throws a ConfigError naming the variable when the list is empty', () => {
    expect(() => requireServerKeys(loadConfig({}))).toThrow(ConfigError);
    expect(() => requireServerKeys(loadConfig({ MCP_SERVER_KEYS: ' , ' }))).toThrow(
      /MCP_SERVER_KEYS/,
    );
  });
});
