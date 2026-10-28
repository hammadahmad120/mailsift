# Build status

Single source of truth for where the project is. Update this file at the end of every piece of work (see the docs-sync rule in `CLAUDE.md`).

Phases are defined in [design-brief.md](design-brief.md) section 12. Do them in order. Never merge or skip.

The phase-by-phase task breakdown with a verify step per task is in [tasks.md](tasks.md). Tick tasks there as they are verified.

| Phase | Scope                                                                                                               | Status                | Done when                                                             |
| ----- | ------------------------------------------------------------------------------------------------------------------- | --------------------- | --------------------------------------------------------------------- |
| 0     | Environment setup: TypeScript, eslint, prettier, vitest, tsup, folder layout, Claude context, docs                  | **Done** (2026-10-22) | `npm run check` green, `node dist/index.js` runs                      |
| 1     | Scaffold: `McpServer` with `get_mailbox_profile` only, stdio transport, env credentials                             | **Done** (2026-10-27) | MCP Inspector lists one tool and calls it with a real read-only token |
| 2     | Gmail adapter, `search_mail`, `get_email` (bodies only), locked client, scope check, error model, recorded fixtures | **Done** (2026-10-28) | Tests pass against recorded JSON, manual search works in Inspector    |
| 3     | Text cleaning and attachments, `get_attachment_text`, all of section 11 with fixtures                               | Not started           | Cleaning and parser tests green on HTML, quoted replies, PDF, DOCX    |
| 4     | `collect_mail` with concurrency, retries, caps, `skipped` and `stats`                                               | Not started           | Bundle call returns documents and stats under the caps                |
| 5     | HTTP transport, server keys, header credentials, `/healthz`, redacted logging, no-token-in-logs test, Dockerfile    | Not started           | curl with the two headers works, logging test green, image builds     |
| 6     | Resources, prompts, README with three examples, npm publish setup                                                   | Not started           | Inspector shows resources and prompts, `npm pack` is clean            |
| 7     | Later, only when asked: IMAP, Microsoft 365, stored-account mode, spreadsheets, OCR                                 | Blocked by design     | Explicit request                                                      |

## Current state of the code

- `src/config.ts` is done: `loadConfig(env)` with zod validation, defaults from the brief, secrets kept off the object.
- `src/errors.ts` is done: `MailError`, `toToolError`, `redactSecrets`.
- `src/providers/types.ts` is done: `Document`, `SearchFilters`, `SearchResult`, `MailboxProfile`, `RawMessage`, and the five-method `MailProvider` interface.
- `src/auth/scope-check.ts` is done: `createScopeCheck({ ttlMs, fetch?, now? })` returns `assertReadOnlyScope(token)`. Calls Google tokeninfo, throws `AUTH_SCOPE_TOO_BROAD` for any scope outside the allow-list and `AUTH_TOKEN_INVALID` when Google rejects the token. Verdicts cached by SHA-256 of the token, capped by the token's own expiry. Wired in front of every tool by `withMailbox`.
- `src/auth/credentials.ts` is done: `createCredentialResolver` reads MAIL_TOKEN or mints from the Gmail refresh trio with an in-memory cache.
- `src/providers/gmail/client.ts` is done: GET-only client with the full read allow-list (`profile`, `messages`, `messages/{id}`, `threads/{id}`, `messages/{id}/attachments/{id}`), Gmail write verbs refused by name, timeout, HTTP status mapping, and retries on 429/5xx (3 tries, backoff, `Retry-After`).
- `src/providers/gmail/mime.ts` is done: pure helpers over a Gmail message payload: `findBodyPart` (plain preferred, else html), `decodeBase64Url`, `readHeaders` (ISO date, split address lists), `listAttachments` (inline parts excluded), `walkParts`. Fixtures `message-plain.json`, `message-html-only.json`, `message-with-attachments.json` in `test/fixtures/gmail/`.
- `src/providers/gmail/provider.ts` is done for `getProfile`, `search` (list ids, then fetch each with `format=full`, metadata only, sequential until task 4.1), `getMessage` (raw body, headers, attachments, link), `getThread` (oldest first). and `getAttachment` (bytes only, decoded from base64url; a stale id is Gmail's 404 as `NOT_FOUND`). Gmail attachment ids change on every message read, so callers resolve attachments from a fresh read. Malformed ids are `NOT_FOUND`. All five methods real. Fixtures `list.json`, `thread.json`, `attachment.json`.
- `src/providers/gmail/query-builder.ts` is done: `buildQuery(filters, { maxRangeDays, now? })`, pure, turns `SearchFilters` into a Gmail `q` string. Values are sanitized (quotes and brackets stripped, phrases quoted), `-in:spam -in:trash` is always appended, `QUERY_EMPTY` and `RANGE_TOO_WIDE` are thrown as `MailError`. Used by `GmailProvider.search`.
- `src/server.ts` is done: `createServer(deps)` makes the `McpServer` and registers the three tools; `createDefaultDeps(env)` is the production wiring (config, env credentials, real scope check with `SCOPE_CACHE_TTL_MS`, Gmail through the locked client with verified scopes). `ServerDeps` = `{ config, resolveCredentials, checkScope, createProvider }` so tests inject fakes.
- `src/tools/with-mailbox.ts` is done: `withMailbox(deps, extra, fn)`, the one per-call sequence every tool runs: credentials -> scope check -> provider -> `fn` -> errors via `toToolError`. No tool file touches credentials or error mapping.
- `src/tools/search-mail.ts` is done: zod input mirroring brief 8.1 plus paging, `page_size` clamped to `MAX_PAGE_SIZE`, handler = `withMailbox` -> `search` -> `toolResult`. Verified in Inspector against a real mailbox.
- `src/tools/get-email.ts` is done: `message_id`, `include_thread`, `max_chars`; handler = `withMailbox` -> `getMessage` (+ `getThread`) -> `toDocument`. Bodies raw until phase 3. Verified in Inspector.
- `src/parse/html-to-text.ts` is done: pure `htmlToText(html)` over `html-to-text`: no wrap, links as `text (url)`, images/style/script skipped, tables as aligned columns, `.gmail_quote` and `.gmail_signature` dropped, blank-line runs collapsed. Fixtures in `test/fixtures/bodies/`. Not wired until task 3.8.
- `src/parse/quotes.ts` is done: the plain-text cleaning step. `stripQuotes` (cuts from the first `On ... wrote:` line, Outlook header block or `-----Original Message-----`, removes `>` lines, protects forwards), `stripSignature` (`-- ` delimiter or sign-off phrase within the last 15 lines, kept when under 200 chars remain), `normalizeWhitespace`, and `cleanBody` composing all three. Fixture pairs in `test/fixtures/bodies/quote-*.txt`. Not wired until task 3.8.
- `src/parse/thread.ts` is done: `flattenThread(messages)` (oldest first, `--- From <from> on <date> ---` per message, each body cleaned) and `bodyToText(raw)` (HTML via `htmlToText`, then `cleanBody`). Verified in Inspector on a real thread.
- `src/parse/attachments/` is done: `parseAttachment({ mime, filename, bytes }, { maxBytes })` dispatching to `pdf.ts` (unpdf, silent, page count, `NO_TEXT_LAYER`), `docx.ts` (mammoth raw text), `text.ts` (txt, md, csv, html). Never throws: `ATTACHMENT_UNSUPPORTED` or `PARSE_FAILED` as values. Generated fixtures in `test/fixtures/attachments/`. Not wired until 3.7 and 3.8.
- `src/parse/document.ts` is done: pure `toDocument(raw, { source, maxChars, thread? })` building the brief section 9 shape, plus `truncate` and `rawBodyText`. `thread_text` is already clean via `flattenThread`; task 3.8 swaps `rawBodyText` for `bodyToText`.
- `src/tools/get-mailbox-profile.ts` is done: empty zod input, read-only annotations, handler = `withMailbox` -> `getProfile` -> `toolResult`; now reports the scopes Google granted. `src/tools/result.ts` holds `toolResult(data, summary)`, the two-block reply every tool uses.
- `src/transports/stdio.ts` is done: `runStdio(server, streams)` connects the server to `StdioServerTransport`; streams are injectable for tests.
- `src/index.ts` is the real CLI entry: `main(argv, options)` returns an exit code, `--stdio` is the default, `--http` exits 1 with a "phase 5" message, config errors exit 1 with the zod message, logs go to stderr only. The direct-run guard compares `import.meta.url` with the resolved `process.argv[1]`, so importing the module in tests never starts a server.
- `examples/claude-code.md` explains getting a read-only token from OAuth Playground, running under MCP Inspector, and the Claude Code `.mcp.json` snippet with `${MAIL_TOKEN}` expansion.
- Empty so far (`.gitkeep` only): `src/resources/`, `src/prompts/`.
- Tests: 217 passing across `config`, `errors`, `credentials`, `scope-check`, `gmail-client`, `gmail-provider`, `query-builder`, `mime`, `document`, `html-to-text`, `quotes`, `thread`, `attachments`, `server` (real MCP `Client` over the SDK in-memory transport), `stdio` (real `StdioServerTransport` driven through in-memory streams), plus the toolchain smoke test. All offline. Recorded fixtures live in `test/fixtures/gmail/`.
- Phases 1 and 2 are complete: every task verified, including the manual Inspector checks (profile with scopes, search by subject with links, get_email by id).
- Not built yet (phase 3+): `get_attachment_text`, collect, HTTP transport, resources, prompts.

## Known issues

- `npm audit` reports a moderate finding in `sprintf-js` via `argparse`, pulled in by `mammoth`'s CLI. The server never uses mammoth's CLI. The only automated fix downgrades mammoth to a 2014 release, so it is left as is. Re-check when mammoth updates its `argparse` dependency.

## Next step

Task 3.7 in [tasks.md](tasks.md), the `get_attachment_text` tool: `src/tools/get-attachment-text.ts` taking `message_id` plus `attachment_id` or `filename`, with the filename fallback when an id is stale, parsing through `parseAttachment`, capping at `max_chars`, returning `{ filename, mime, size, text, truncated, pages }` or a skip reason. Then 3.8 wiring into `get_email`, 3.9 docs sync.
