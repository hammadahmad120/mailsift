import { describe, expect, it } from 'vitest';
import { headerValue } from '../src/auth/headers.js';

describe('headerValue', () => {
  it('reads lowercase and mixed-case names and trims the value', () => {
    expect(headerValue({ 'x-mail-token': ' abc ' }, 'X-Mail-Token')).toBe('abc');
    expect(headerValue({ 'X-Mail-Token': 'abc' }, 'x-mail-token')).toBe('abc');
    expect(headerValue({ Authorization: 'Bearer k' }, 'authorization')).toBe('Bearer k');
  });

  it('treats absent, blank and repeated headers as missing', () => {
    expect(headerValue({}, 'x-mail-token')).toBeUndefined();
    expect(headerValue({ 'x-mail-token': '' }, 'x-mail-token')).toBeUndefined();
    expect(headerValue({ 'x-mail-token': '   ' }, 'x-mail-token')).toBeUndefined();
    expect(headerValue({ 'x-mail-token': undefined }, 'x-mail-token')).toBeUndefined();
    expect(headerValue({ 'x-mail-token': ['a', 'b'] }, 'x-mail-token')).toBeUndefined();
  });
});
