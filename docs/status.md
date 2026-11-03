# Build status

Single source of truth for where the project is. Update this file at the end of every piece of work (see the docs-sync rule in `CLAUDE.md`).

Phases are defined in [design-brief.md](design-brief.md) section 12. Do them in order. Never merge or skip.

The phase-by-phase task breakdown with a verify step per task is in [tasks.md](tasks.md). Tick tasks there as they are verified.

| Phase | Scope                                                                                                               | Status                                            | Done when                                                             |
| ----- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- | --------------------------------------------------------------------- |
| 0     | Environment setup: TypeScript, eslint, prettier, vitest, tsup, folder layout, Claude context, docs                  | **Done** (2026-10-22)                             | `npm run check` green, `node dist/index.js` runs                      |
| 1     | Scaffold: `McpServer` with `get_mailbox_profile` only, stdio transport, env credentials                             | **Done** (2026-10-27)                             | MCP Inspector lists one tool and calls it with a real read-only token |
| 2     | Gmail adapter, `search_mail`, `get_email` (bodies only), locked client, scope check, error model, recorded fixtures | **Done** (2026-10-28)                             | Tests pass against recorded JSON, manual search works in Inspector    |
| 3     | Text cleaning and attachments, `get_attachment_text`, all of section 11 with fixtures                               | **Done** (2026-10-28)                             | Cleaning and parser tests green on HTML, quoted replies, PDF, DOCX    |
| 4     | `collect_mail` with concurrency, retries, caps, `skipped` and `stats`; `get_attachment_file` for original bytes     | **Done** (2026-10-29)                             | Bundle call returns documents and stats under the caps                |
| 5     | HTTP transport, server keys, header credentials, `/healthz`, redacted logging, no-token-in-logs test, Dockerfile    | **Done** (2026-11-03, image build pending Docker) | curl with the two headers works, logging test green, image builds     |
| 6     | Resources, prompts, README with three examples, npm publish setup                                                   | Not started                                       | Inspector shows resources and prompts, `npm pack` is clean            |
| 7     | Later, only when asked: IMAP, Microsoft 365, stored-account mode, spreadsheets, OCR                                 | Blocked by design                                 | Explicit request                                                      |

## Current state of the code

Phases 0 to 5 are complete; phase 6 in progress. Six tools, two resources, two resource templates, three prompts, two transports, one provider. `npm run check` is green (344 tests, all offline).

**Config, errors, logging**

- `src/config.ts`: `loadConfig(env)`, zod-validated, frozen. Limits from brief section 15 plus `MAX_SEARCH_IDS`, `LOG_LEVEL` (default `info`), `MCP_SERVER_KEYS`, `PORT` (0 allowed, any free port), `HOST` (default `0.0.0.0`). Secrets are never on the config object.
- `src/errors.ts`: `MailError { code, message, hint }`, `toToolError` (tools), `toMcpError` (resources and prompts: a JSON-RPC error with the structured body in `data`, `NOT_FOUND` as invalid params, the rest as internal error), `redactSecrets` (Google access and refresh tokens, client secrets, JWTs, `Bearer` values, `access_token=` / `refresh_token=` params).
- `src/logging.ts`: `createLogger({ level, sink, now })`, one JSON object per line on stderr; `child(fields)`; `silentLogger()`. `redactRecord` blanks secret field names (`authorization`, `x-mail-token`, `token`, `refresh_token`, `client_secret`, ...) and runs every other string through `redactSecrets`; Errors become `{ name, message, code? }`; cycles and depth over 8 are cut. The brief's no-token-in-logs test is `test/logging.test.ts`.

**Auth (`src/auth/`)**

- `credentials.ts`: the one place credentials enter. Strict by transport: with `extra.requestInfo` (HTTP) only `X-Mail-Token` and `X-Mail-Provider` count and a missing token is `AUTH_MISSING_TOKEN`; without it (stdio) `MAIL_TOKEN` or the Gmail refresh trio with an in-memory mint cache. Header tokens are never cached.
- `scope-check.ts`: Google tokeninfo, `AUTH_SCOPE_TOO_BROAD` for anything outside the read-only allow-list, `AUTH_TOKEN_INVALID` when Google rejects the token, verdicts cached by SHA-256 of the token.
- `server-keys.ts`: `createServerKeyCheck(keys)` compares `Authorization: Bearer` against every key with `timingSafeEqual`, throws `AUTH_SERVER_KEY` without echoing the value; `requireServerKeys(config)` throws `ConfigError` when `MCP_SERVER_KEYS` is empty.
- `headers.ts`: `headerValue`, case-insensitive, trimmed, blank or repeated header is missing.

**Gmail provider (`src/providers/`)**

- `types.ts`: `Document`, `SearchFilters`, `SearchResult`, `MessageIdPage`, `MailboxProfile`, `RawMessage`, and the six-method `MailProvider` (`getProfile`, `listMessageIds`, `search`, `getMessage`, `getThread`, `getAttachment`).
- `gmail/client.ts`: GET-only `fetch` client, explicit path allow-list (`profile`, `messages`, `messages/{id}`, `threads/{id}`, `messages/{id}/attachments/{id}`), write verbs refused by name, timeout, status mapping, retries on 429/5xx with `Retry-After`.
- `gmail/query-builder.ts`: pure `buildQuery(filters)` to a Gmail `q` string, sanitised, `-in:spam -in:trash` always, `QUERY_EMPTY` and `RANGE_TOO_WIDE`.
- `gmail/mime.ts`: pure payload helpers (`findBodyPart`, `decodeBase64Url`, `readHeaders`, `listAttachments`, `walkParts`).
- `gmail/provider.ts`: all six methods real. `search` lists ids then fetches `fetchConcurrency` at a time; `getThread` oldest first; `getAttachment` bytes only. Gmail attachment ids change on every read, so tools resolve attachments from a fresh read.

**Parsing (`src/parse/`, all pure)**

- `html-to-text.ts`, `quotes.ts` (`stripQuotes`, `stripSignature`, `normalizeWhitespace`, `cleanBody`), `thread.ts` (`flattenThread`, `bodyToText`), `document.ts` (`toDocument` building the brief section 9 shape, `truncate`), `markdown.ts` (`documentToMarkdown`, `threadToMarkdown`, `formatBytes`: the reading form of a Document for the resource templates), `attachments/` (`parseAttachment` dispatching to pdf via unpdf, docx via mammoth, text; never throws, `ATTACHMENT_UNSUPPORTED` / `PARSE_FAILED` as values).

**Tools (`src/tools/`, one file each)**

- `with-mailbox.ts`: `withMailboxOrThrow(deps, name, extra, fn)` is the core: credentials -> scope check -> provider -> `fn`, one log line per call (`tool`, `rpc_id`, `duration_ms`, `code` on failure; `request_id` comes from the HTTP layer's child logger), any throw rethrown as `McpError`. `withMailbox` wraps it for tools and turns the throw into a structured tool error. Resources call the core directly.
- `get-mailbox-profile.ts`, `search-mail.ts`, `get-email.ts` (thread and attachment text options), `get-attachment-text.ts`, `get-attachment-file.ts` (original bytes as an embedded resource under `mail://attachment/{message_id}/{filename}`), `collect-mail.ts` (`collectMail` core: id walk with `order`, `pLimit` fetches, caps, `skipped`, `stats`).
- Helpers: `attachment-texts.ts`, `args.ts` (blank optional strings dropped), `result.ts` (`toolResult`, the two-block reply).
- `src/util/concurrency.ts`: `pLimit`.

**Server, transports, entry**

- `src/server.ts`: `createServer(deps)` registers the six tools; `createDefaultDeps(env, { logSink? })` is production wiring. `ServerDeps = { config, resolveCredentials, checkScope, createProvider, logger }`.
- `src/transports/stdio.ts`: `runStdio(server, streams)`.
- `src/transports/http.ts`: `createHttpApp(deps)` (refuses without server keys) and `runHttp(deps, { port, host })`. Per request: `X-Request-Id` and a child logger, open `GET /healthz`, server key middleware on `/mcp` (401 structured), `express.json` at 100 kB, a fresh `McpServer` plus stateless `StreamableHTTPServerTransport` with JSON replies, closed with the response. 404, 405, 400 and 500 answer `{ code, message, hint }`. One `http` access line per request.
- `src/index.ts`: `main(argv, options)`. `--stdio` default; `--http` binds `HOST:PORT`, resolves 0 once listening, closes on `options.signal`; the direct-run guard maps `SIGTERM`/`SIGINT` to it. Config errors, empty keys and bind failures are one JSON error line and exit 1.
- `Dockerfile` (multi-stage `node:20-alpine`, production deps plus `dist`, `USER node`, `HEALTHCHECK` on `/healthz` via Node `fetch`, `CMD node dist/index.js --http`) and `.dockerignore`. Written and reviewed, not yet built: no Docker on the development machine.

**Docs and examples**

- `examples/claude-code.md` (token from OAuth Playground, Inspector, Claude Code `.mcp.json`), `examples/curl-http.md` (start commands, the four headers, curl for initialize, tools/list, tools/call, failure table, logs), `examples/agent-loop.md` (backend loop: MCP SDK client over HTTP with both headers, tools wrapped for the Vercel AI SDK, `collect_for_brief` fetched by name, `stepCountIs` cap, token minting from a refresh token, failure table).
- `package.json` has `dev:env` (`node --env-file=.env --import tsx src/index.ts`) for local runs from a `.env`.

**Resources (`src/resources/`, one file each)**

- `profile.ts`: `mail://profile`, `application/json`, same data as the tool, read through `withMailboxOrThrow`.
- `search-syntax.ts`: `mail://search-syntax`, `text/markdown`, pure `renderSearchSyntax({ maxRangeDays, now? })` rendered on every read: a table from `FIELD_DOCS` (eleven `SearchFilters` fields, type, Gmail syntax, notes), the rules (required field, range cap from config, spam and trash excluded, paging), six `EXAMPLES` whose Gmail query lines are produced by `buildQuery`. No credentials.
- `message.ts`: template `mail://message/{message_id}`, `text/markdown`. One `getMessage`, `toDocument` with the server's `maxMessageChars`, attachments listed only, `documentToMarkdown`. No `list` callback.
- `thread.ts`: template `mail://thread/{thread_id}`, `text/markdown`. One `getThread`, every message through `toDocument`, `threadToMarkdown` (oldest first, numbered sections).
- `variables.ts`: `templateVariable(variables, name)`, one non-empty string out of a matched template or `NOT_FOUND`.

**Prompts (`src/prompts/`, one file each, no mailbox access)**

- `build-mail-query.ts`: `build_mail_query(request, today, default_window_days)`, all required strings. One user message: the request, today, the window, the eleven filter fields, "never invent a sender", range cap from config, "say what is missing".
- `collect-for-brief.ts`: `collect_for_brief(brief, hints?)`. The workflow: read `mail://search-syntax`, `search_mail`, refine at most `MAX_REFINEMENTS` (2) times (narrow over `MAX_COLLECT_MESSAGES`, widen under `MIN_USEFUL_RESULTS` (3)), `collect_mail` once, stop, report; still unsure after two: report and ask one question.
- `explain-results.ts`: `explain_results()`, no arguments. Plain-words summary of the last `collect_mail` reply: found and returned counts, skipped grouped by reason, query used, one next step, under 150 words.

**Manual checks done**

- Phases 1 to 4 in Inspector against a real mailbox (profile with scopes, search, clean `get_email` on a thread, PDF through `get_attachment_text` and `get_email`, `collect_mail` with stats and `oldest_first`, `get_attachment_file` byte for byte).
- Phase 5 over HTTP from Postman (2026-11-03): `tools/list` and `get_mailbox_profile` with both headers, `AUTH_MISSING_TOKEN` without `X-Mail-Token`, 406 without the `Accept` header, graceful stop on Ctrl-C.

## Known issues

- The Docker image has not been built or run yet. The Dockerfile is complete but unverified until someone with Docker runs `docker build -t mailsift .` and the `docker run` plus `/healthz` check from task 5.5.
- Newsletter and marketing footers (About blocks, social links, addresses) are not stripped; deferred, see decisions.md 2026-10-28.
- Gmail attachment ids change on every message read. Tools resolve attachments from a fresh read and prefer `filename`; ids from earlier replies are hints only.
- `collect_mail` reports `messages_found` from Gmail's `resultSizeEstimate` when it did not walk to the end of the results; Gmail's estimate can be off. When the walk reached the end the count is exact.
- `npm audit` reports a moderate finding in `sprintf-js` via `argparse`, pulled in by `mammoth`'s CLI. The server never uses mammoth's CLI. The only automated fix downgrades mammoth to a 2014 release, so it is left as is. Re-check when mammoth updates its `argparse` dependency.

## Next step

Task 6.5 in [tasks.md](tasks.md): npm publish setup (`prepublishOnly`, `files` whitelist, GitHub Actions).
