import { describe, expect, it } from 'vitest';
import { ERROR_CODES, MailError, isMailError, redactSecrets, toToolError } from '../src/errors.js';
import type { ToolErrorBody } from '../src/errors.js';

function bodyOf(result: ReturnType<typeof toToolError>): ToolErrorBody {
  const first = result.content[0];
  if (!first || first.type !== 'text') throw new Error('expected a text block');
  return JSON.parse(first.text) as ToolErrorBody;
}

describe('MailError', () => {
  it('carries code, message and a default hint', () => {
    const err = new MailError('AUTH_MISSING_TOKEN');
    expect(err.code).toBe('AUTH_MISSING_TOKEN');
    expect(err.message).toBe('AUTH_MISSING_TOKEN');
    expect(err.hint).toMatch(/Connect a mailbox/);
    expect(isMailError(err)).toBe(true);
  });

  it('lets a custom message and hint override the defaults', () => {
    const err = new MailError('RANGE_TOO_WIDE', 'Range is 900 days', 'Use at most 365 days.');
    expect(err.message).toBe('Range is 900 days');
    expect(err.hint).toBe('Use at most 365 days.');
  });

  it('has a hint for every code except PROVIDER_ERROR', () => {
    for (const code of ERROR_CODES) {
      const err = new MailError(code);
      if (code === 'PROVIDER_ERROR') expect(err.hint).toBeUndefined();
      else expect(typeof err.hint).toBe('string');
    }
  });
});

describe('toToolError', () => {
  it('returns an MCP tool error with one JSON text block', () => {
    const result = toToolError(new MailError('NOT_FOUND', 'Message abc not found'));
    expect(result.isError).toBe(true);
    expect(result.content).toHaveLength(1);
    expect(bodyOf(result)).toEqual({
      code: 'NOT_FOUND',
      message: 'Message abc not found',
      hint: expect.stringMatching(/Check the id/) as string,
    });
  });

  it('maps an unknown error to PROVIDER_ERROR without leaking its message', () => {
    const result = toToolError(new Error('ECONNRESET at /internal/path secret=xyz'));
    const body = bodyOf(result);
    expect(body.code).toBe('PROVIDER_ERROR');
    expect(body.message).not.toContain('ECONNRESET');
    expect(body.message).not.toContain('xyz');
    expect(body.hint).toBeUndefined();
  });

  it('handles non-Error throwables', () => {
    expect(bodyOf(toToolError('boom')).code).toBe('PROVIDER_ERROR');
    expect(bodyOf(toToolError(undefined)).code).toBe('PROVIDER_ERROR');
  });

  it('never lets a token value through, even inside a MailError message', () => {
    const token = 'ya29.a0AfH6SMBxyz-very-secret-token';
    const result = toToolError(
      new MailError('AUTH_TOKEN_INVALID', `Google rejected Bearer ${token} (${token})`),
    );
    const text = JSON.stringify(result);
    expect(text).not.toContain(token);
    expect(text).toContain('[redacted]');
  });
});

describe('redactSecrets', () => {
  it('redacts Google access tokens, bearer values and access_token params', () => {
    expect(redactSecrets('token ya29.abc-DEF_123 here')).toBe('token [redacted] here');
    expect(redactSecrets('Authorization: Bearer whatever.value')).toBe(
      'Authorization: Bearer [redacted]',
    );
    expect(redactSecrets('https://x?access_token=abc123&y=1')).toBe(
      'https://x?access_token=[redacted]&y=1',
    );
  });

  it('leaves ordinary text alone', () => {
    expect(redactSecrets('Message 18f not found')).toBe('Message 18f not found');
  });
});
