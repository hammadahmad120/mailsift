import { describe, expect, it } from 'vitest';
import { MailError } from '../src/errors.js';
import { createLogger, redactRecord, silentLogger, type LogFields } from '../src/logging.js';

const TOKEN = 'ya29.a0AfH6SMB-this-must-never-appear';
/** A token that matches no known shape; only field-name redaction can catch it. */
const OPAQUE = 'plain-opaque-secret-value-9f8e7d';
const FIXED_NOW = new Date('2026-11-02T10:00:00.000Z');

function capture(level?: 'debug' | 'info' | 'warn' | 'error') {
  const lines: string[] = [];
  const logger = createLogger({ sink: (line) => lines.push(line), now: () => FIXED_NOW, level });
  const parsed = (): LogFields[] => lines.map((line) => JSON.parse(line) as LogFields);
  return { lines, logger, parsed };
}

describe('createLogger', () => {
  it('writes one JSON object per line with time, level, msg and the fields', () => {
    const { logger, parsed, lines } = capture();

    logger.info('tool', { tool: 'search_mail', duration_ms: 42 });

    expect(lines).toHaveLength(1);
    expect(parsed()[0]).toEqual({
      time: '2026-11-02T10:00:00.000Z',
      level: 'info',
      msg: 'tool',
      tool: 'search_mail',
      duration_ms: 42,
    });
  });

  it('never writes a token, whatever shape it arrives in (brief section 7, point 6)', () => {
    const { logger, lines } = capture('debug');

    logger.error('request failed', {
      headers: { Authorization: `Bearer ${OPAQUE}`, 'X-Mail-Token': OPAQUE, accept: 'json' },
      error: new MailError('AUTH_TOKEN_INVALID', `Google rejected ${TOKEN}`),
      nested: { deeper: { token: OPAQUE, note: `token ${TOKEN} inline` } },
      url: `https://x?access_token=${OPAQUE}&refresh_token=${OPAQUE}`,
      refresh_token: OPAQUE,
      list: [TOKEN, { client_secret: OPAQUE }],
    });
    logger.debug(`message with ${TOKEN} inside`, { token: OPAQUE });

    const output = lines.join('\n');
    expect(output).not.toContain(TOKEN);
    expect(output).not.toContain(OPAQUE);
    // the non-secret parts survive
    expect(output).toContain('"accept":"json"');
    expect(output).toContain('"code":"AUTH_TOKEN_INVALID"');
    expect(output).toContain('"note":"token [redacted] inline"');
  });

  it('drops lines below the configured level and keeps the rest', () => {
    const { logger, parsed } = capture('warn');

    logger.debug('a');
    logger.info('b');
    logger.warn('c');
    logger.error('d');

    expect(parsed().map((l) => l['level'])).toEqual(['warn', 'error']);
  });

  it('defaults to info', () => {
    const { logger, parsed } = capture();
    logger.debug('hidden');
    logger.info('shown');
    expect(parsed().map((l) => l['msg'])).toEqual(['shown']);
  });

  it('child loggers carry their fields on every line', () => {
    const { logger, parsed } = capture();
    const child = logger.child({ request_id: 'req-1' });

    child.info('one');
    child.warn('two', { extra: true });

    expect(parsed()).toMatchObject([
      { request_id: 'req-1', msg: 'one' },
      { request_id: 'req-1', msg: 'two', extra: true },
    ]);
  });

  it('serialises Errors as name, message and code without a stack', () => {
    const { logger, parsed } = capture();

    logger.error('boom', { error: new MailError('NOT_FOUND', 'gone', 'try again') });
    logger.error('boom', { error: new TypeError('bad') });

    expect(parsed()[0]?.['error']).toEqual({
      name: 'MailError',
      message: 'gone',
      code: 'NOT_FOUND',
    });
    expect(parsed()[1]?.['error']).toEqual({ name: 'TypeError', message: 'bad' });
  });

  it('survives circular references and deep nesting', () => {
    const { logger, lines } = capture();
    const loop: Record<string, unknown> = { name: 'loop' };
    loop['self'] = loop;
    let deep: Record<string, unknown> = { end: true };
    for (let i = 0; i < 20; i += 1) deep = { next: deep };

    expect(() => logger.info('cycles', { loop, deep })).not.toThrow();
    expect(lines[0]).toContain('[circular]');
    expect(lines[0]).toContain('[depth]');
  });

  it('writes nothing from the silent logger', () => {
    const logger = silentLogger();
    expect(() => {
      logger.error('ignored', { token: TOKEN });
    }).not.toThrow();
  });
});

describe('redactRecord', () => {
  it('matches secret field names case-insensitively and across - and _', () => {
    const out = redactRecord({
      AUTHORIZATION: 'x',
      'x-mail-token': 'x',
      X_MAIL_TOKEN: 'x',
      Token: 'x',
      message_id: '18f0',
      attachment_id: 'ANGjdJ_long_id',
    }) as LogFields;

    expect(out).toEqual({
      AUTHORIZATION: '[redacted]',
      'x-mail-token': '[redacted]',
      X_MAIL_TOKEN: '[redacted]',
      Token: '[redacted]',
      message_id: '18f0',
      attachment_id: 'ANGjdJ_long_id',
    });
  });

  it('turns dates into ISO strings, bigints into strings and skips functions and undefined', () => {
    const out = redactRecord({
      when: new Date('2026-01-01T00:00:00.000Z'),
      big: 10n,
      fn: () => 1,
      missing: undefined,
      list: [1, 'two', null],
    }) as LogFields;

    expect(out).toEqual({ when: '2026-01-01T00:00:00.000Z', big: '10', list: [1, 'two', null] });
  });
});
