/**
 * Shared reader for incoming HTTP header maps.
 * Node lowercases header names; the SDK's `extra.requestInfo.headers` and Express `req.headers`
 * both follow that shape, but callers in tests may pass mixed case, so lookups ignore case.
 */

export type HeaderMap = Record<string, string | string[] | undefined>;

/**
 * One header's value, trimmed. `undefined` when the header is absent, blank, or sent more than once
 * (a repeated credential header is ambiguous, so it is treated as missing rather than picking one).
 */
export function headerValue(headers: HeaderMap, name: string): string | undefined {
  const wanted = name.toLowerCase();
  let found: string | string[] | undefined = headers[wanted];
  if (found === undefined) {
    const key = Object.keys(headers).find((k) => k.toLowerCase() === wanted);
    if (key !== undefined) found = headers[key];
  }
  if (found === undefined || Array.isArray(found)) return undefined;
  const trimmed = found.trim();
  return trimmed === '' ? undefined : trimmed;
}
