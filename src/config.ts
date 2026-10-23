import { z } from 'zod';

/**
 * All runtime settings, read once from the environment at startup.
 *
 * Secrets (MAIL_TOKEN, GMAIL_REFRESH_TOKEN, GMAIL_CLIENT_SECRET) are deliberately
 * NOT stored on this object. They are read by `resolveCredentials` at call time so
 * the config can be passed around and logged without leaking anything.
 */

const positiveInt = (defaultValue: number) =>
  z.coerce.number().int().positive().default(defaultValue);

const optionalString = z
  .string()
  .trim()
  .transform((value) => (value === '' ? undefined : value))
  .optional();

const envSchema = z.object({
  // --- limits (brief section 15) ---
  MAX_RANGE_DAYS: positiveInt(365),
  MAX_PAGE_SIZE: positiveInt(100),
  MAX_COLLECT_MESSAGES: positiveInt(200),
  MAX_ATTACHMENT_BYTES: positiveInt(10_485_760),
  MAX_MESSAGE_CHARS: positiveInt(50_000),
  MAX_ATTACHMENT_CHARS: positiveInt(100_000),
  MAX_TOTAL_CHARS: positiveInt(2_000_000),
  FETCH_CONCURRENCY: positiveInt(5),
  GMAIL_TIMEOUT_MS: positiveInt(20_000),
  SCOPE_CACHE_TTL_MS: positiveInt(600_000),

  // --- stdio provider selection (brief section 6) ---
  MAIL_PROVIDER: z.enum(['gmail']).default('gmail'),

  // --- http transport (brief section 6) ---
  MCP_SERVER_KEYS: optionalString,
  PORT: positiveInt(3000),
});

export interface Config {
  readonly limits: {
    readonly maxRangeDays: number;
    readonly maxPageSize: number;
    readonly maxCollectMessages: number;
    readonly maxAttachmentBytes: number;
    readonly maxMessageChars: number;
    readonly maxAttachmentChars: number;
    readonly maxTotalChars: number;
    readonly fetchConcurrency: number;
    readonly gmailTimeoutMs: number;
    readonly scopeCacheTtlMs: number;
  };
  readonly provider: 'gmail';
  readonly http: {
    readonly port: number;
    /** Parsed from comma-separated MCP_SERVER_KEYS. Empty when unset. */
    readonly serverKeys: readonly string[];
  };
}

export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env);

  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new ConfigError(`Invalid environment configuration. ${details}`);
  }

  const e = parsed.data;

  const serverKeys = (e.MCP_SERVER_KEYS ?? '')
    .split(',')
    .map((key) => key.trim())
    .filter((key) => key.length > 0);

  return Object.freeze({
    limits: Object.freeze({
      maxRangeDays: e.MAX_RANGE_DAYS,
      maxPageSize: e.MAX_PAGE_SIZE,
      maxCollectMessages: e.MAX_COLLECT_MESSAGES,
      maxAttachmentBytes: e.MAX_ATTACHMENT_BYTES,
      maxMessageChars: e.MAX_MESSAGE_CHARS,
      maxAttachmentChars: e.MAX_ATTACHMENT_CHARS,
      maxTotalChars: e.MAX_TOTAL_CHARS,
      fetchConcurrency: e.FETCH_CONCURRENCY,
      gmailTimeoutMs: e.GMAIL_TIMEOUT_MS,
      scopeCacheTtlMs: e.SCOPE_CACHE_TTL_MS,
    }),
    provider: e.MAIL_PROVIDER,
    http: Object.freeze({
      port: e.PORT,
      serverKeys: Object.freeze(serverKeys),
    }),
  });
}
