import { describe, expect, it } from 'vitest';
import { PACKAGE_NAME, parseTransportFlag } from '../src/index.js';

describe('environment smoke test', () => {
  it('exposes the package name', () => {
    expect(PACKAGE_NAME).toBe('mailsift');
  });

  it('defaults to stdio and recognises --http', () => {
    expect(parseTransportFlag([])).toBe('stdio');
    expect(parseTransportFlag(['--stdio'])).toBe('stdio');
    expect(parseTransportFlag(['--http'])).toBe('http');
  });
});
