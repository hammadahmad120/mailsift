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
| 4     | `collect_mail` with concurrency, retries, caps, `skipped` and `stats`; `get_attachment_file` for original bytes     | Not started           | Bundle call returns documents and stats under the caps                |
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
- `src/server.ts` is done: `createServer(deps)` makes the `McpServer` and registers the four tools; `createDefaultDeps(env)` is the production wiring (config, env credentials, real scope check with `SCOPE_CACHE_TTL_MS`, Gmail through the locked client with verified scopes). `ServerDeps` = `{ config, resolveCredentials, checkScope, createProvider }` so tests inject fakes.
- `src/tools/with-mailbox.ts` is done: `withMailbox(deps, extra, fn)`, the one per-call sequence every tool runs: credentials -> scope check -> provider -> `fn` -> errors via `toToolError`. No tool file touches credentials or error mapping.
- `src/tools/search-mail.ts` is done: zod input mirroring brief 8.1 plus paging, blanks dropped, `page_size` clamped to `MAX_PAGE_SIZE`, handler = `withMailbox` -> `search` -> `toolResult`. Verified in Inspector against a real mailbox.
- `src/tools/get-email.ts` is done: `message_id`, `include_thread`, `attachments` (`list` default, `text`, `none`), `max_chars`, `max_attachment_chars`; handler = `withMailbox` -> `getMessage` (+ `getThread`, + `attachmentTexts`) -> `toDocument`. Body and thread text clean. Verified in Inspector.
- `src/tools/attachment-texts.ts` is done: `attachmentTexts(provider, raw, { maxBytes, maxChars })` fetches each attachment with ids from the same message read, parses, caps, and keeps any failure local to that attachment (`PARSE_FAILED`). Sequential until task 4.1; `collect_mail` will reuse it.
- `src/parse/html-to-text.ts` is done: pure `htmlToText(html)` over `html-to-text`: no wrap, links as `text (url)`, images/style/script skipped, tables as aligned columns, `.gmail_quote` and `.gmail_signature` dropped, blank-line runs collapsed. Fixtures in `test/fixtures/bodies/`.
- `src/parse/quotes.ts` is done: the plain-text cleaning step. `stripQuotes` (cuts from the first `On ... wrote:` line, Outlook header block or `-----Original Message-----`, removes `>` lines, protects forwards), `stripSignature` (`-- ` delimiter or sign-off phrase within the last 15 lines, kept when under 200 chars remain), `normalizeWhitespace`, and `cleanBody` composing all three. Fixture pairs in `test/fixtures/bodies/quote-*.txt`.
- `src/parse/thread.ts` is done: `flattenThread(messages)` (oldest first, `--- From <from> on <date> ---` per message, each body cleaned) and `bodyToText(raw)` (HTML via `htmlToText`, then `cleanBody`). Verified in Inspector on a real thread.
- `src/parse/attachments/` is done: `parseAttachment({ mime, filename, bytes }, { maxBytes })` dispatching to `pdf.ts` (unpdf, silent, page count, `NO_TEXT_LAYER`), `docx.ts` (mammoth raw text), `text.ts` (txt, md, csv, html). Never throws: `ATTACHMENT_UNSUPPORTED` or `PARSE_FAILED` as values. Generated fixtures in `test/fixtures/attachments/`.
- `src/parse/document.ts` is done: pure `toDocument(raw, { source, maxChars, thread?, attachments? })` building the brief section 9 shape, `text` via `bodyToText` and `thread_text` via `flattenThread`, plus `truncate` and `listedAttachments`.
- `src/tools/get-attachment-text.ts` is done: `message_id` plus `filename` (preferred) or `attachment_id`; reads the message, resolves the attachment (id match, else filename, else the only one), fetches bytes with the fresh id, `parseAttachment`, `truncate` at `max_chars`. Skips are values with `skipped_reason`. Verified in Inspector on a real PDF.
- `src/tools/args.ts` is done: `optionalText`, `present`, `presentList`; optional text arguments accept "" (Inspector sends it) and handlers drop blanks.
- `src/tools/get-mailbox-profile.ts` is done: empty zod input, read-only annotations, handler = `withMailbox` -> `getProfile` -> `toolResult`; now reports the scopes Google granted. `src/tools/result.ts` holds `toolResult(data, summary)`, the two-block reply every tool uses.
- `src/transports/stdio.ts` is done: `runStdio(server, streams)` connects the server to `StdioServerTransport`; streams are injectable for tests.
- `src/index.ts` is the real CLI entry: `main(argv, options)` returns an exit code, `--stdio` is the default, `--http` exits 1 with a "phase 5" message, config errors exit 1 with the zod message, logs go to stderr only. The direct-run guard compares `import.meta.url` with the resolved `process.argv[1]`, so importing the module in tests never starts a server.
- `examples/claude-code.md` explains getting a read-only token from OAuth Playground, running under MCP Inspector, and the Claude Code `.mcp.json` snippet with `${MAIL_TOKEN}` expansion.
- Empty so far (`.gitkeep` only): `src/resources/`, `src/prompts/`.
- Tests: 233 passing across `config`, `errors`, `credentials`, `scope-check`, `gmail-client`, `gmail-provider`, `query-builder`, `mime`, `document`, `html-to-text`, `quotes`, `thread`, `attachments`, `server` (real MCP `Client` over the SDK in-memory transport), `stdio` (real `StdioServerTransport` driven through in-memory streams), plus the toolchain smoke test. All offline. Recorded fixtures live in `test/fixtures/gmail/`.
- Phases 1 to 3 are complete: every task verified, including the manual Inspector checks (profile with scopes, search with links, clean `get_email` on a real thread, a real PDF through `get_attachment_text` and through `get_email` with `attachments: "text"`).
- Not built yet (phase 4+): concurrency limiter, `collect_mail`, HTTP transport, logger, server keys, header credentials, Dockerfile, resources, prompts, npm publish.

## Known issues

- Newsletter and marketing footers (About blocks, social links, addresses) are not stripped; deferred, see decisions.md 2026-10-28.
- Gmail attachment ids change on every message read. Tools resolve attachments from a fresh read and prefer `filename`; ids from earlier replies are hints only.
- `search` and `attachmentTexts` fetch sequentially until task 4.1 adds the concurrency limiter.
- `npm audit` reports a moderate finding in `sprintf-js` via `argparse`, pulled in by `mammoth`'s CLI. The server never uses mammoth's CLI. The only automated fix downgrades mammoth to a 2014 release, so it is left as is. Re-check when mammoth updates its `argparse` dependency.

## Next step

Phase 4 starts with task 4.1 in [tasks.md](tasks.md), the concurrency limiter: a dependency-free `pLimit(n)` in `src/util/concurrency.ts` with a test proving at most `n` tasks run at once. Then 4.2 `collect_mail` (decide the message-order open question when it starts), 4.3 `get_attachment_file` (original bytes for apps that store files), and 4.4 docs sync.
