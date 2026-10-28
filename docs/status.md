# Build status

Single source of truth for where the project is. Update this file at the end of every piece of work (see the docs-sync rule in `CLAUDE.md`).

Phases are defined in [design-brief.md](design-brief.md) section 12. Do them in order. Never merge or skip.

The phase-by-phase task breakdown with a verify step per task is in [tasks.md](tasks.md). Tick tasks there as they are verified.

| Phase | Scope                                                                                                               | Status                        | Done when                                                             |
| ----- | ------------------------------------------------------------------------------------------------------------------- | ----------------------------- | --------------------------------------------------------------------- |
| 0     | Environment setup: TypeScript, eslint, prettier, vitest, tsup, folder layout, Claude context, docs                  | **Done** (2026-10-22)         | `npm run check` green, `node dist/index.js` runs                      |
| 1     | Scaffold: `McpServer` with `get_mailbox_profile` only, stdio transport, env credentials                             | **Done** (2026-10-27)         | MCP Inspector lists one tool and calls it with a real read-only token |
| 2     | Gmail adapter, `search_mail`, `get_email` (bodies only), locked client, scope check, error model, recorded fixtures | In progress (2.1 to 2.5 done) | Tests pass against recorded JSON, manual search works in Inspector    |
| 3     | Text cleaning and attachments, `get_attachment_text`, all of section 11 with fixtures                               | Not started                   | Cleaning and parser tests green on HTML, quoted replies, PDF, DOCX    |
| 4     | `collect_mail` with concurrency, retries, caps, `skipped` and `stats`                                               | Not started                   | Bundle call returns documents and stats under the caps                |
| 5     | HTTP transport, server keys, header credentials, `/healthz`, redacted logging, no-token-in-logs test, Dockerfile    | Not started                   | curl with the two headers works, logging test green, image builds     |
| 6     | Resources, prompts, README with three examples, npm publish setup                                                   | Not started                   | Inspector shows resources and prompts, `npm pack` is clean            |
| 7     | Later, only when asked: IMAP, Microsoft 365, stored-account mode, spreadsheets, OCR                                 | Blocked by design             | Explicit request                                                      |

## Current state of the code

- `src/config.ts` is done: `loadConfig(env)` with zod validation, defaults from the brief, secrets kept off the object.
- `src/errors.ts` is done: `MailError`, `toToolError`, `redactSecrets`.
- `src/providers/types.ts` is done: `Document`, `SearchFilters`, `SearchResult`, `MailboxProfile`, `RawMessage`, and the five-method `MailProvider` interface.
- `src/auth/scope-check.ts` is done: `createScopeCheck({ ttlMs, fetch?, now? })` returns `assertReadOnlyScope(token)`. Calls Google tokeninfo, throws `AUTH_SCOPE_TOO_BROAD` for any scope outside the allow-list and `AUTH_TOKEN_INVALID` when Google rejects the token. Verdicts cached by SHA-256 of the token, capped by the token's own expiry. Not yet wired in front of tools (task 2.8).
- `src/auth/credentials.ts` is done: `createCredentialResolver` reads MAIL_TOKEN or mints from the Gmail refresh trio with an in-memory cache.
- `src/providers/gmail/client.ts` is done: GET-only client with the full read allow-list (`profile`, `messages`, `messages/{id}`, `threads/{id}`, `messages/{id}/attachments/{id}`), Gmail write verbs refused by name, timeout, HTTP status mapping, and retries on 429/5xx (3 tries, backoff, `Retry-After`).
- `src/providers/gmail/mime.ts` is done: pure helpers over a Gmail message payload: `findBodyPart` (plain preferred, else html), `decodeBase64Url`, `readHeaders` (ISO date, split address lists), `listAttachments` (inline parts excluded), `walkParts`. Fixtures `message-plain.json`, `message-html-only.json`, `message-with-attachments.json` in `test/fixtures/gmail/`.
- `src/providers/gmail/provider.ts` is done for `getProfile`, `search` (list ids, then fetch each with `format=full`, metadata only, sequential until task 4.1), `getMessage` (raw body, headers, attachments, link), `getThread` (oldest first). Malformed ids are `NOT_FOUND`. `getAttachment` throws "not implemented" until task 3.6. Fixtures `list.json` and `thread.json` added.
- `src/providers/gmail/query-builder.ts` is done: `buildQuery(filters, { maxRangeDays, now? })`, pure, turns `SearchFilters` into a Gmail `q` string. Values are sanitized (quotes and brackets stripped, phrases quoted), `-in:spam -in:trash` is always appended, `QUERY_EMPTY` and `RANGE_TOO_WIDE` are thrown as `MailError`. Not yet wired to the provider (task 2.5).
- `src/server.ts` is done: `createServer(deps)` makes the `McpServer` and registers tools; `createDefaultDeps(env)` is the production wiring (config, env credentials, Gmail through the locked client). Tool handlers get their dependencies through `ServerDeps` so tests inject fakes.
- `src/tools/get-mailbox-profile.ts` is done: the first tool, empty zod input, read-only annotations, handler = resolve credentials -> build provider -> `getProfile` -> `toolResult`, errors via `toToolError`. `src/tools/result.ts` holds `toolResult(data, summary)`, the two-block reply every tool uses.
- `src/transports/stdio.ts` is done: `runStdio(server, streams)` connects the server to `StdioServerTransport`; streams are injectable for tests.
- `src/index.ts` is the real CLI entry: `main(argv, options)` returns an exit code, `--stdio` is the default, `--http` exits 1 with a "phase 5" message, config errors exit 1 with the zod message, logs go to stderr only. The direct-run guard compares `import.meta.url` with the resolved `process.argv[1]`, so importing the module in tests never starts a server.
- `examples/claude-code.md` explains getting a read-only token from OAuth Playground, running under MCP Inspector, and the Claude Code `.mcp.json` snippet with `${MAIL_TOKEN}` expansion.
- Empty so far (`.gitkeep` only): `src/resources/`, `src/prompts/`, `src/parse/attachments/`.
- Tests: 142 passing across `config`, `errors`, `credentials`, `scope-check`, `gmail-client`, `gmail-provider`, `query-builder`, `mime`, `server` (real MCP `Client` over the SDK in-memory transport), `stdio` (real `StdioServerTransport` driven through in-memory streams), plus the toolchain smoke test. All offline. Recorded fixtures live in `test/fixtures/gmail/`.
- Phase 1 is complete: all nine tasks verified, including the manual Inspector check against a real read-only token.
- Not built yet (phase 2+): search/get tools, cleaning, attachments, collect, HTTP transport, resources, prompts.

## Known issues

- `npm audit` reports a moderate finding in `sprintf-js` via `argparse`, pulled in by `mammoth`'s CLI. The server never uses mammoth's CLI. The only automated fix downgrades mammoth to a 2014 release, so it is left as is. Re-check when mammoth updates its `argparse` dependency.

## Next step

Task 2.6 in [tasks.md](tasks.md), the `search_mail` tool: `src/tools/search-mail.ts` with a zod input schema mirroring `SearchFilters` plus `page_size` and `page_token`, read-only annotations, handler = resolve credentials -> provider -> `search` -> `toolResult`, errors via `toToolError`. Registered in `createServer`. Tested over the in-memory MCP client with a fake provider. Phase 2 ends at 2.9 with a manual search and get in Inspector.
