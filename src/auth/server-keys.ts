import { timingSafeEqual } from 'node:crypto';
import type { Config } from '../config.js';
import { ConfigError } from '../config.js';
import { MailError } from '../errors.js';

/**
 * The server key check for the HTTP transport (brief section 6).
 *
 * `Authorization: Bearer <key>` proves the caller may use this server at all.
 * It is separate from `X-Mail-Token`, which names the mailbox being read.
 * Keys are static secrets the operator generates and lists in `MCP_SERVER_KEYS`,
 * several so one can be rotated or revoked without touching the others.
 *
 * Every comparison is constant time: a wrong key costs the same as a right one
 * whatever its length or how many leading characters match.
 */

/** Header map as Node and Express hand it over: lowercased names, string or string[] values. */
export type HeaderMap = Record<string, string | string[] | undefined>;

export type ServerKeyCheck = (headers: HeaderMap) => void;

const BEARER = /^Bearer\s+(\S+)\s*$/i;

/** Constant-time string equality. Unequal lengths still take a full comparison. */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) {
    // Compare something of the right length anyway so the length check is not a timing signal.
    timingSafeEqual(left, left);
    return false;
  }
  return timingSafeEqual(left, right);
}

function headerValue(headers: HeaderMap, name: string): string | undefined {
  const direct = headers[name] ?? headers[name.toLowerCase()];
  if (direct !== undefined) return Array.isArray(direct) ? undefined : direct;
  // Fall back to a case-insensitive scan for callers that pass raw header objects.
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name.toLowerCase());
  const value = key === undefined ? undefined : headers[key];
  return Array.isArray(value) ? undefined : value;
}

/** Pulls the bearer value out of the Authorization header, or undefined when absent or malformed. */
export function bearerToken(headers: HeaderMap): string | undefined {
  const raw = headerValue(headers, 'authorization');
  if (raw === undefined) return undefined;
  const match = BEARER.exec(raw);
  return match?.[1];
}

/**
 * Builds the check from the parsed key list (`config.http.serverKeys`).
 * Throws `AUTH_SERVER_KEY` for a missing header, a non-Bearer scheme, or an unknown key.
 * The error message never includes what the caller sent.
 */
export function createServerKeyCheck(keys: readonly string[]): ServerKeyCheck {
  const configured = keys.filter((key) => key.length > 0);

  return (headers) => {
    const presented = bearerToken(headers);
    if (presented === undefined) {
      throw new MailError('AUTH_SERVER_KEY', 'Missing or malformed Authorization header.');
    }

    // Check every key rather than stopping at the first match, so the count of
    // comparisons does not depend on which key matched.
    let matched = false;
    for (const key of configured) {
      if (safeEqual(presented, key)) matched = true;
    }
    if (!matched) {
      throw new MailError('AUTH_SERVER_KEY', 'Server key not recognised.');
    }
  };
}

/**
 * HTTP mode must not start without at least one key (brief section 6).
 * Called by the HTTP entry point before it binds a port. Stdio mode never calls it.
 */
export function requireServerKeys(config: Config): readonly string[] {
  if (config.http.serverKeys.length === 0) {
    throw new ConfigError(
      'MCP_SERVER_KEYS is empty. The HTTP transport refuses to start without at least one server key. ' +
        'Generate one with `openssl rand -hex 32` and set MCP_SERVER_KEYS=<key>[,<key>...].',
    );
  }
  return config.http.serverKeys;
}
