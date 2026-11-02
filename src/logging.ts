import { redactSecrets } from './errors.js';

/**
 * Structured logger: one JSON object per line on stderr (brief section 7, point 6).
 *
 * Redaction happens on the whole record, not on strings a caller remembers to clean:
 *   1. any field whose name is a known credential carrier (`authorization`,
 *      `x-mail-token`, `token`, `refresh_token`, ...) is replaced by `[redacted]`,
 *      whatever its value looks like
 *   2. every remaining string runs through `redactSecrets` for the known token shapes
 *
 * stdout is never used: in stdio mode it is the MCP protocol channel.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];

export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  /** A logger that adds `fields` to every line, e.g. a request id for one HTTP request. */
  child(fields: LogFields): Logger;
}

export interface LoggerOptions {
  /** Lowest level that is written. Default `info`. */
  level?: LogLevel | undefined;
  /** Where finished lines go. Default: stderr. Tests pass an array push. */
  sink?: ((line: string) => void) | undefined;
  now?: (() => Date) | undefined;
}

export const REDACTED = '[redacted]';

/**
 * Field names whose value is always a secret. Compared after lowercasing and
 * turning `-` into `_`, so `Authorization`, `X-Mail-Token` and `x_mail_token` all match.
 */
const SECRET_KEYS: ReadonlySet<string> = new Set([
  'authorization',
  'proxy_authorization',
  'x_mail_token',
  'mail_token',
  'token',
  'access_token',
  'id_token',
  'refresh_token',
  'gmail_refresh_token',
  'client_secret',
  'gmail_client_secret',
  'mcp_server_keys',
  'server_key',
  'api_key',
  'secret',
  'password',
  'cookie',
  'set_cookie',
]);

const MAX_DEPTH = 8;

const LEVEL_RANK: Readonly<Record<LogLevel, number>> = { debug: 0, info: 1, warn: 2, error: 3 };

function isSecretKey(key: string): boolean {
  return SECRET_KEYS.has(key.toLowerCase().replace(/-/g, '_'));
}

/**
 * Pure: returns a JSON-safe copy of `value` with secrets removed.
 * Errors become `{ name, message, code? }`, dates become ISO strings, cycles become `[circular]`.
 */
export function redactRecord(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redactSecrets(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'function' || typeof value === 'symbol') return undefined;
  if (value instanceof Date) return value.toISOString();

  if (typeof value === 'object') {
    if (seen.has(value)) return '[circular]';
    if (depth >= MAX_DEPTH) return '[depth]';
    seen.add(value);

    if (value instanceof Error) {
      const out: LogFields = { name: value.name, message: redactSecrets(value.message) };
      const code = (value as { code?: unknown }).code;
      if (typeof code === 'string') out['code'] = code;
      return out;
    }

    if (Array.isArray(value)) {
      return value.map((item) => redactRecord(item, depth + 1, seen));
    }

    const out: LogFields = {};
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined) continue;
      out[key] = isSecretKey(key) ? REDACTED : redactRecord(item, depth + 1, seen);
    }
    return out;
  }

  // Every typeof branch is handled above; this keeps the function total.
  return undefined;
}

function defaultSink(line: string): void {
  process.stderr.write(line + '\n');
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const level = options.level ?? 'info';
  const sink = options.sink ?? defaultSink;
  const now = options.now ?? (() => new Date());
  const threshold = LEVEL_RANK[level];

  const make = (base: LogFields): Logger => {
    const write = (lvl: LogLevel, msg: string, fields?: LogFields): void => {
      if (LEVEL_RANK[lvl] < threshold) return;
      const record = redactRecord({ ...base, ...fields }) as LogFields;
      const line = { time: now().toISOString(), level: lvl, msg: redactSecrets(msg), ...record };
      sink(JSON.stringify(line));
    };

    return {
      debug: (msg, fields) => write('debug', msg, fields),
      info: (msg, fields) => write('info', msg, fields),
      warn: (msg, fields) => write('warn', msg, fields),
      error: (msg, fields) => write('error', msg, fields),
      child: (fields) => make({ ...base, ...fields }),
    };
  };

  return make({});
}

/** A logger that writes nothing. For tests and for callers that do not care. */
export function silentLogger(): Logger {
  return createLogger({ sink: () => undefined, level: 'error' });
}
