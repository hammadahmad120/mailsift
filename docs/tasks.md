# Task list

The whole server broken into small tasks. One task at a time. Each task ends with something you can verify yourself before we move on. Tick the box when verified.

Phases come from [design-brief.md](design-brief.md) section 12. Tasks never cross a phase boundary.

How to read a task:

- **Build**: what gets written.
- **Why**: the MCP or design idea behind it, in plain words.
- **Files**: where it lives.
- **Verify**: what you run or look at to confirm it works.

---

## MCP in five sentences

An MCP server is a program that offers three kinds of things to an AI client: **tools** (functions the model can call, with a typed input schema), **resources** (read-only content the model can load by URI, like a file), and **prompts** (reusable instruction templates the client can insert). The client (Claude Code, Cursor, an app, MCP Inspector) talks to the server over a **transport**: **stdio** means the client launches the server as a child process and talks over stdin/stdout; **Streamable HTTP** means the server listens on a URL and the client sends HTTP requests. The server and client exchange JSON-RPC messages; the SDK hides that. A tool call returns a list of **content blocks** (we always return one text block of JSON plus a short summary) and an `isError` flag. MCP Inspector is a browser UI that connects to any server and lets you list and call tools by hand, which is how you will verify most tasks.

---

## Phase 1 — Scaffold: one tool over stdio

Goal: a real MCP server with one tool, `get_mailbox_profile`, that you can call from MCP Inspector with a real Gmail token.

- [x] **1.1 Config module** (verified 2026-10-23)
  - Build: `loadConfig()` that reads every env var from brief section 15 plus `MAIL_PROVIDER`, `MAIL_TOKEN`, `MCP_SERVER_KEYS`, applies defaults, validates with zod, and returns a frozen typed object.
  - Why: every limit in the server comes from one place. Nothing else reads `process.env`.
  - Files: `src/config.ts`, `test/config.test.ts`.
  - Verify: `npm test` shows config tests: defaults apply when env is empty, overrides apply, a bad value (e.g. `MAX_PAGE_SIZE=abc`) throws a clear message.

- [x] **1.2 Error model** (verified 2026-10-23)
  - Build: the `ErrorCode` union from brief section 10, a `MailError` class with `code`, `message`, `hint`, and `toToolError(err)` that turns any thrown error into the MCP tool-error reply `{ isError: true, content: [{ type: "text", text: JSON }] }`. Unknown errors become `PROVIDER_ERROR` with no internals leaked.
  - Why: MCP tool errors are returned, not thrown, so the model can read the hint and decide what to do next. One function guarantees every tool fails the same way.
  - Files: `src/errors.ts`, `test/errors.test.ts`.
  - Verify: tests show each code maps to its hint, a random `Error("boom")` becomes `PROVIDER_ERROR`, and a token string passed inside an error message never appears in the output.

- [x] **1.3 Provider interface and Document types** (verified 2026-10-23)
  - Build: TypeScript types for `Document`, `DocumentAttachment`, `SearchFilters`, `SearchResult`, `MailboxProfile`, and the `MailProvider` interface with exactly five methods: `getProfile`, `search`, `getMessage`, `getThread`, `getAttachment`.
  - Why: tools talk to this interface, never to Gmail directly. That is what lets IMAP and Microsoft 365 plug in later without touching the tools. Five read methods and nothing else is also read-only enforcement layer 2.
  - Files: `src/providers/types.ts`.
  - Verify: `npm run typecheck` green. You read the file and compare the `Document` type field by field against brief section 9.

- [x] **1.4 Credentials from env (stdio side)** (verified 2026-10-23, includes refresh-token minting)
  - Build: `resolveCredentials(extra)` returning `{ provider, token }`. In this task it only reads env (`MAIL_PROVIDER`, `MAIL_TOKEN`). Missing token throws `MailError("AUTH_MISSING_TOKEN")`.
  - Why: this one function is the only place credentials enter the server. Phase 5 adds the HTTP header branch here and nowhere else.
  - Files: `src/auth/credentials.ts`, `test/credentials.test.ts`.
  - Verify: tests show env token is returned, missing token gives `AUTH_MISSING_TOKEN`, and provider defaults to `gmail`.

- [x] **1.5 Locked Gmail HTTP client (minimal)** (verified 2026-10-23)
  - Build: `gmailGet(path, token, opts)` wrapping `fetch`. Only `GET`. Only paths on an allow-list (this task: `profile` only). Timeout from config. Maps HTTP 401 to `AUTH_TOKEN_INVALID`, 404 to `NOT_FOUND`, 429 to `RATE_LIMITED`, others to `PROVIDER_ERROR`. No retry yet.
  - Why: read-only enforcement layer 4. Every byte that goes to Google passes through here, so a write is impossible by construction, not by discipline.
  - Files: `src/providers/gmail/client.ts`, `test/gmail-client.test.ts`.
  - Verify: tests with a mocked `fetch` show: an unknown path throws before `fetch` is called, the request method is always `GET`, status codes map to the right error codes, and the `Authorization` header is set from the token.

- [x] **1.6 Gmail provider: profile only** (verified 2026-10-23)
  - Build: `GmailProvider` implementing `MailProvider`, with `getProfile()` working and the other four methods throwing `PROVIDER_ERROR("not implemented")` for now.
  - Why: first real data from Google, through the locked client.
  - Files: `src/providers/gmail/provider.ts`, `test/fixtures/gmail/profile.json`, `test/gmail-provider.test.ts`.
  - Verify: test feeds the recorded profile JSON through a mocked client and checks the `MailboxProfile` output has `email_address`, `messages_total`, `threads_total`, `provider: "gmail"`, `read_only: true`.

- [x] **1.7 McpServer with the first tool** (verified 2026-10-27)
  - Build: `createServer()` that makes an `McpServer`, and `registerGetMailboxProfile(server)` that registers the tool with an empty zod input, the three read-only annotations, and a handler that resolves credentials, builds the provider, calls `getProfile`, and returns one JSON text block plus a one-line summary. Errors go through `toToolError`.
  - Why: this is the heart of MCP. You will see how a tool is declared (name, description, input schema, annotations) and how a handler returns content. Every later tool follows this exact pattern.
  - Files: `src/server.ts`, `src/tools/get-mailbox-profile.ts`, `test/server.test.ts`.
  - Verify: the test uses the SDK's in-memory transport to connect a real MCP `Client` to the server, calls `listTools()` and sees one tool with `readOnlyHint: true`, then calls it with a fake provider and reads the JSON back. No network.

- [x] **1.8 stdio transport and CLI entry** (verified 2026-10-27, Inspector check done)
  - Build: `runStdio()` connecting the server to `StdioServerTransport`. `src/index.ts` parses `--stdio` (default) and `--http` (prints "not yet" for now). Logs go to stderr only, because stdout is the protocol channel.
  - Why: this is how Claude Code and Cursor launch MCP servers. Writing anything to stdout other than protocol messages corrupts the connection, which is why `no-console` is an eslint error.
  - Files: `src/transports/stdio.ts`, `src/index.ts`, `examples/claude-code.md`.
  - Verify (manual, the phase 1 gate): get a read-only token from Google OAuth Playground, then run `npx @modelcontextprotocol/inspector npx tsx src/index.ts` with `MAIL_TOKEN` set, open the browser UI, see `get_mailbox_profile` in the tools list, call it, see your email address and message count. Also add the server to Claude Code with the snippet in `examples/claude-code.md` and ask Claude to check the mailbox.

- [x] **1.9 Phase 1 docs sync** (verified 2026-10-27)
  - Build: `/sync-docs`. Mark phase 1 done in `status.md`, note the locked-client-in-phase-1 ordering in `decisions.md`, remove any `.gitkeep` next to real files.
  - Verify: `npm run check` green, `docs/status.md` says phase 1 done with today's date.

---

## Phase 2 — Gmail adapter, `search_mail`, `get_email` (raw bodies)

Goal: find messages by filters and read one message's body. No cleaning yet, no attachments text yet.

- [x] **2.1 Query builder** (verified 2026-10-28)
  - Build: `buildQuery(filters)` turning `SearchFilters` into a Gmail `q` string. Quoting and escaping of values, `after:`/`before:` in `YYYY/MM/DD`, `keywords` joined with AND, `any_keywords` as `{a b c}`, `attachment_types` to `filename:` ORs, `raw_query` appended, always `-in:spam -in:trash`. Throws `QUERY_EMPTY` with no filter and `RANGE_TOO_WIDE` when the date span exceeds `MAX_RANGE_DAYS`.
  - Why: pure function, no network, and the single place Gmail search syntax is known. Everything a model types ends up here.
  - Files: `src/providers/gmail/query-builder.ts`, `test/query-builder.test.ts`.
  - Verify: one test per field, plus escaping of quotes and spaces, plus both error cases. The test file doubles as the spec for the `mail://search-syntax` resource later.

- [x] **2.2 Scope check** (verified 2026-10-28)
  - Build: `assertReadOnlyScope(token)` calling Google's tokeninfo endpoint, parsing `scope`, rejecting with `AUTH_SCOPE_TOO_BROAD` if any scope is outside the allow-list, and `AUTH_TOKEN_INVALID` if Google says the token is bad. Verdicts cached for `SCOPE_CACHE_TTL_MS` keyed by SHA-256 of the token.
  - Why: read-only enforcement layer 3. Even a caller that sends a full-access token is turned away before any Gmail call.
  - Files: `src/auth/scope-check.ts`, `test/scope-check.test.ts`.
  - Verify: tests with mocked `fetch`: read-only scope passes, `gmail.modify` fails, second call within TTL does not hit `fetch`, cache key is not the raw token.

- [x] **2.3 Locked client: full allow-list and retries** (verified 2026-10-28)
  - Build: extend the allow-list to `messages` (list), `messages/{id}`, `threads/{id}`, `messages/{id}/attachments/{attachmentId}`. Add retry with backoff for `429` and `5xx`, max 3 tries, respecting `Retry-After`.
  - Why: brief section 8.4 and 17. Retries live in the client so every caller gets them.
  - Files: `src/providers/gmail/client.ts`, `test/gmail-client.test.ts`.
  - Verify: tests show a path like `messages/abc/modify` is still refused, a `503` then `200` sequence succeeds on the second try, three `429`s end as `RATE_LIMITED`.

- [x] **2.4 MIME helpers** (verified 2026-10-28)
  - Build: functions that walk a Gmail message payload: find the best body part (`text/plain` preferred, else `text/html`), decode base64url, read headers (`From`, `To`, `Cc`, `Subject`, `Date`) into the `Document.headers` shape, and list attachment parts (filename, mime, size, attachment id).
  - Why: Gmail returns a nested MIME tree. These pure functions flatten it so the provider stays small.
  - Files: `src/providers/gmail/mime.ts`, `test/fixtures/gmail/message-plain.json`, `message-html-only.json`, `message-with-attachments.json`, `test/mime.test.ts`.
  - Verify: one test per fixture: plain body picked, html picked when no plain, two attachments listed with correct sizes, inline images excluded.

- [x] **2.5 Gmail provider: search, getMessage, getThread** (verified 2026-10-28)
  - Build: `search(filters, pageSize, pageToken)` which lists ids then fetches metadata for each, `getMessage(id)` returning a raw `Document` (body text still uncleaned), `getThread(id)` returning messages in date order.
  - Why: completes the adapter for everything except attachments.
  - Files: `src/providers/gmail/provider.ts`, `test/fixtures/gmail/list.json`, `thread.json`, `test/gmail-provider.test.ts`.
  - Verify: tests against recorded JSON check the `SearchResult` items have `link` in the Gmail URL format and `getThread` returns messages sorted by date.

- [x] **2.6 `search_mail` tool** (verified 2026-10-28, Inspector search done)
  - Build: tool with the zod input from brief section 8.1, page size capped at `MAX_PAGE_SIZE`, output exactly as the brief shows.
  - Why: the model's first real tool. Metadata only, never bodies, so replies stay small.
  - Files: `src/tools/search-mail.ts`, `test/server.test.ts`.
  - Verify: in-memory client test calls the tool with a fake provider and checks `query_used`, `items`, `next_page_token`. Manual: in Inspector, search your own mailbox by subject and see results with links.

- [x] **2.7 `get_email` tool (raw)** (verified 2026-10-28)
  - Build: tool with `message_id`, `include_thread`, `max_chars`. Returns a `Document`. Attachments listed, not extracted. Body truncated at `max_chars` with `truncated: true`.
  - Files: `src/tools/get-email.ts`, `test/server.test.ts`.
  - Verify: test checks truncation flag and thread text presence. Manual: paste a `message_id` from your search into Inspector and read the body.

- [x] **2.8 Shared tool wrapper** (verified 2026-10-28)
  - Build: `withMailbox(extra, fn)` that does the full per-call sequence: resolve credentials, scope check, build provider, run `fn`, map errors. Every tool handler becomes three lines.
  - Why: guarantees no tool can forget the scope check.
  - Files: `src/tools/with-mailbox.ts`, `test/server.test.ts`.
  - Verify: tests show that with no token every tool returns `AUTH_MISSING_TOKEN`, and with a broad scope every tool returns `AUTH_SCOPE_TOO_BROAD`.

- [x] **2.9 Phase 2 docs sync** (verified 2026-10-28)
  - Verify: `npm run check` green, status updated, Inspector manual check done for search and get.

---

## Phase 3 — Text cleaning and attachments

Goal: bodies come out clean, attachments come out as text, `get_attachment_text` works.

- [x] **3.1 HTML to text** (verified 2026-10-28)
  - Build: `htmlToText(html)` wrapping `html-to-text` with the brief's settings: no images, links as `text (url)`, tables flattened.
  - Files: `src/parse/html-to-text.ts`, `test/fixtures/bodies/*.html`, `test/html-to-text.test.ts`.
  - Verify: fixture tests, including a Gmail-style HTML reply and a newsletter.

- [x] **3.2 Quoted reply stripping** (verified 2026-10-28)
  - Build: `stripQuotes(text)` removing `>` lines, blocks after `On <date>, <name> wrote:`, Outlook `From: … Sent: …` blocks, and the `gmail_quote` div (handled at the HTML stage).
  - Files: `src/parse/quotes.ts`, `test/fixtures/bodies/*.txt`, `test/quotes.test.ts`.
  - Verify: each pattern has a fixture pair (input, expected).

- [x] **3.3 Signature stripping and whitespace** (verified 2026-10-28)
  - Build: `stripSignature(text)` for `-- ` and common sign-offs, keeping it when the remainder is under 200 chars. `normalizeWhitespace(text)` collapsing more than two blank lines and trimming. `cleanBody(text)` composing all of it.
  - Files: `src/parse/quotes.ts`, `test/quotes.test.ts`.
  - Verify: tests for the 200-char rule in both directions.

- [x] **3.4 Thread flattening** (verified 2026-10-28, checked in Inspector on a real thread)
  - Build: `flattenThread(messages)` producing `--- From <from> on <date> ---` separated text in date order, each body cleaned.
  - Files: `src/parse/thread.ts`, `test/thread.test.ts`.
  - Verify: test with three messages out of order checks ordering and separators.

- [x] **3.5 Attachment parsers** (verified 2026-10-28)
  - Build: `parseAttachment({ mime, filename, bytes })` dispatching to `text.ts` (txt, md, csv, html), `pdf.ts` (unpdf, reports `pages`, `NO_TEXT_LAYER` for scans), `docx.ts` (mammoth raw text). Size cap, unsupported types and parse failures return `{ skipped_reason }` and never throw.
  - Why: pure functions, every failure is a value, so one bad file never breaks a 50-message collect.
  - Files: `src/parse/attachments/{index,text,pdf,docx}.ts`, `test/fixtures/attachments/sample.pdf`, `sample.docx`, `scanned.pdf`, `sample.csv`, `test/attachments.test.ts`.
  - Verify: tests extract known sentences from the sample PDF and DOCX, scanned PDF gives `NO_TEXT_LAYER`, a `.zip` gives `ATTACHMENT_UNSUPPORTED`, an 11 MB buffer gives `ATTACHMENT_UNSUPPORTED`, a corrupted PDF gives `PARSE_FAILED`.

- [x] **3.6 Gmail provider: getAttachment** (verified 2026-10-28)
  - Build: `getAttachment(messageId, attachmentId)` returning bytes, via the locked client.
  - Files: `src/providers/gmail/provider.ts`, `test/fixtures/gmail/attachment.json`.
  - Verify: test decodes the recorded base64url into the expected byte length.

- [x] **3.7 `get_attachment_text` tool** (verified 2026-10-28, real PDF read in Inspector; stale-id and blank-field bugs found and fixed during verify)
  - Build: tool accepting `attachment_id` or `filename`, with the filename fallback when the id is stale.
  - Files: `src/tools/get-attachment-text.ts`, `test/server.test.ts`.
  - Verify: test simulates a stale id (`NOT_FOUND`) and sees the fallback succeed by filename. Manual: pull a real PDF's text in Inspector.

- [x] **3.8 Wire cleaning and attachments into `get_email`** (verified 2026-10-28)
  - Build: `get_email` now returns cleaned `text`, honours `attachments: "text" | "list" | "none"`, and `max_attachment_chars`.
  - Verify: Inspector shows a reply email with the quoted history gone and the PDF text inline.

- [x] **3.9 Phase 3 docs sync** (verified 2026-10-28)

---

## Phase 4 — `collect_mail`

Goal: one call that returns a whole pile of documents under hard caps.

- [x] **4.1 Concurrency limiter** (verified 2026-10-29)
  - Build: a tiny `pLimit(n)` helper, no dependency. Helper only; wiring into `search` and `attachmentTexts` happens in 4.2.
  - Files: `src/util/concurrency.ts`, `test/concurrency.test.ts`.
  - Verify: test proves at most `n` tasks run at once.

- [x] **4.2 `collect_mail` tool** (verified 2026-10-29)
  - Build: page message ids with the new `listMessageIds` provider method (ids only, no double fetch) until `max_messages`, fetch and convert with `pLimit(FETCH_CONCURRENCY)` through the same code as `get_email`, add documents in order until `max_total_chars` (the cap also stops further fetching), fill `skipped` (per message with an error code, per attachment with its filename, and `MAX_TOTAL_CHARS` for what the cap left out) and `stats`. `pLimit` is now also wired into `GmailProvider.search` and `attachmentTexts`.
  - Files: `src/tools/collect-mail.ts`, `src/providers/types.ts`, `src/providers/gmail/provider.ts`, `src/config.ts`, `test/server.test.ts`, `test/gmail-provider.test.ts`.
  - Open question (raised 2026-10-23) resolved 2026-10-29, see decisions.md: `order: "newest_first" | "oldest_first"`, default `newest_first`. `oldest_first` walks the id list to the end (capped by `MAX_SEARCH_IDS`, default 2000), reverses, takes `max_messages`. `search_mail` keeps Gmail order.
  - Verify: test with a fake provider of 30 messages and `max_total_chars` small enough to cut off at 10 checks `stats.truncated: true` and `messages_returned: 10`. Manual: collect last month's mail with attachments in Inspector, read the stats block.

- [x] **4.3 `get_attachment_file` tool** (added 2026-10-28, see decisions.md; verified 2026-10-29)
  - Build: `src/tools/get-attachment-file.ts` taking `message_id` plus `filename` or `attachment_id`, same resolution as `get_attachment_text` through the shared `findAttachment` (fresh read, id match, else filename, else the only one). Returns the original bytes unchanged: a JSON block `{ attachment_id, filename, mime, size }` plus an MCP embedded resource (`type: "resource"`, `uri: mail://attachment/{message_id}/{filename}`, `blob` as base64, `mimeType`), then the summary line. Over `MAX_ATTACHMENT_BYTES` is `ATTACHMENT_UNSUPPORTED` as a structured error: checked against the listed size before any download, and again against the real size after. No parsing.
  - Why: an app that stores documents wants the file as sent, not the extracted text. The server already has the bytes; handing them over keeps Gmail knowledge and the attachment-id churn out of the app.
  - Files: `src/tools/get-attachment-file.ts`, `test/server.test.ts`.
  - Verify: test decodes the blob and gets the sample PDF byte for byte; an oversized attachment is refused; the every-tool scope tests include it. Manual: fetch a real PDF in Inspector, decode the base64, open the file.

- [x] **4.4 Phase 4 docs sync** (verified 2026-10-29)

---

## Phase 5 — HTTP transport

Goal: the same server reachable over a URL with two headers, safe to run in Docker.

- [x] **5.1 Logger with redaction** (verified 2026-11-02)
  - Build: structured JSON logger to stderr with request id, tool name, duration, counts. Redacts `Authorization`, `X-Mail-Token`, and any value that looks like a bearer token. As built: `createLogger` with `LOG_LEVEL` (new env var, default `info`), field-name redaction plus `redactSecrets` on every string, `withMailbox(deps, tool, extra, fn)` writes one line per tool call, `main` logs startup as JSON too.
  - Files: `src/logging.ts`, `test/logging.test.ts`, `src/tools/with-mailbox.ts`, `src/config.ts`, `src/server.ts`, `src/index.ts`.
  - Verify: the brief's required test: log an object containing a token value, capture output, assert the token string is absent. Manual: `LOG_LEVEL=debug MAIL_TOKEN=<token> npm run dev`, call a tool from Inspector, see one JSON line per call on the terminal with `tool`, `request_id`, `duration_ms`, and grep the output for the token: zero hits.

- [x] **5.2 Server key check** (verified 2026-11-02)
  - Build: `assertServerKey(headers)` comparing `Authorization: Bearer` against `MCP_SERVER_KEYS` using constant-time comparison. `AUTH_SERVER_KEY` on failure. Server refuses to start in HTTP mode if the env is empty. As built: `createServerKeyCheck(keys)` returns the check, `safeEqual` wraps `timingSafeEqual`, `bearerToken` parses the header, `requireServerKeys(config)` throws `ConfigError` on an empty list for the HTTP entry point (5.4/5.5) to call. `/healthz` will stay outside the check.
  - Files: `src/auth/server-keys.ts`, `test/server-keys.test.ts`.
  - Verify: `npm run check` green; tests show a valid key passes, a wrong key, a prefix, a missing header and a `Basic` scheme all give `AUTH_SERVER_KEY`, the error never echoes the presented value, and `requireServerKeys` throws on an empty `MCP_SERVER_KEYS`.

- [x] **5.3 Header credentials** (verified 2026-11-02)
  - Build: `resolveCredentials(extra)` gains the HTTP branch reading `X-Mail-Provider` and `X-Mail-Token` from `extra.requestInfo.headers`. As built: strict by transport. When `requestInfo` is present (HTTP) only the headers count and a missing `X-Mail-Token` is `AUTH_MISSING_TOKEN` even with env credentials set; env is the stdio path. `credentialsFromHeaders` and `isHttpRequest` exported; shared `headerValue` in `src/auth/headers.ts` used by server keys too.
  - Why: the one-place rule from task 1.4 pays off here.
  - Files: `src/auth/credentials.ts`, `src/auth/headers.ts`, `test/credentials.test.ts`, `test/headers.test.ts`.
  - Verify: tests cover env (stdio), headers (HTTP), env ignored on HTTP, missing header on HTTP is a structured error that never carries the env token, provider header honoured and refused, blank and repeated headers treated as missing, header tokens never cached.

- [x] **5.4 Express app with Streamable HTTP** (ticked 2026-11-03; tests green, manual curl check deferred to the end of phase 5)
  - Build: `POST /mcp` using `StreamableHTTPServerTransport` in stateless mode (new transport per request, no sessions, which matches "stateless" in the brief), `GET /healthz`. Server key checked before the transport sees the request. As built: `createHttpApp(deps)` (throws `ConfigError` on empty keys) and `runHttp(deps, { port, host })`; one `McpServer` plus one transport per request with `enableJsonResponse`; request id in `X-Request-Id`, per-request child logger so `http` and `tool` lines share `request_id`; 401/404/405/400/500 all answer the structured `{ code, message, hint }` body; `/healthz` open.
  - Why: this is the transport apps and InstantBot will use. Stateless means any replica can serve any request.
  - Files: `src/transports/http.ts`, `test/http.test.ts`, `examples/curl-http.md`.
  - Verify: `test/http.test.ts` (Node `fetch` against an ephemeral port, no new dependency) posts `initialize` and `tools/list` and gets JSON back; no key is 401; a `tools/call` with `X-Mail-Token` reaches the provider with that token; the same call without it is `AUTH_MISSING_TOKEN` even with `MAIL_TOKEN` in the env; logs carry the request id and never the token or key. Manual: start with the one-liner in `examples/curl-http.md` (the CLI `--http` flag is task 5.5), then run its curl commands.

- [x] **5.5 CLI `--http` and Dockerfile** (verified 2026-11-03 over HTTP with Postman; `docker build` still pending a machine with Docker)
  - Build: `index.ts` wires `--http`, reads `PORT`. Multi-stage Dockerfile on `node:20-alpine`, non-root user, `HEALTHCHECK` on `/healthz`. As built: `main(['--http'])` builds deps, calls `runHttp` with `HOST` (new env var, default `0.0.0.0`) and `PORT` (0 now allowed, meaning any free port), resolves 0 once bound, and closes the listener when `options.signal` aborts; the direct-run guard wires `SIGTERM`/`SIGINT` to that signal. Bind failures and empty `MCP_SERVER_KEYS` are one JSON error line and exit code 1. Dockerfile: build stage runs `npm ci` and `npm run build`, runtime stage has `npm ci --omit=dev` plus `dist`, `USER node`, `EXPOSE 3000`, `HEALTHCHECK` through `node -e fetch(...)`, `CMD node dist/index.js --http`. `.dockerignore` keeps `node_modules`, `.env*`, docs and tests out.
  - Files: `src/index.ts`, `src/config.ts`, `test/stdio.test.ts`, `test/config.test.ts`, `Dockerfile`, `.dockerignore`.
  - Verify: `npm run check` green; `MCP_SERVER_KEYS=dev-key npm run dev -- --http` then the curl commands in `examples/curl-http.md` (this is also the deferred 5.4 manual check); Ctrl-C stops it with an `http server stopping` line. On a machine with Docker: `docker build -t mailsift .` then `docker run -e MCP_SERVER_KEYS=dev -p 3000:3000 mailsift` and curl `/healthz`.

- [x] **5.6 Phase 5 docs sync** (2026-11-03)

---

## Phase 6 — Resources, prompts, README, publish

Goal: a complete MCP server and a repo someone else can use.

- [x] **6.1 Static resources** (verified 2026-11-03)
  - Build: `mail://profile` (same as the tool) and `mail://search-syntax` (markdown generated from the query builder's field list, six examples). As built: `registerProfileResource` reads through `withMailboxOrThrow`, the new throwing core that `withMailbox` now wraps, so a failed read is a JSON-RPC error carrying the `{ code, message, hint }` body (`toMcpError` in `errors.ts`). `renderSearchSyntax({ maxRangeDays })` is pure, rendered on every read, with `FIELD_DOCS` (one row per `SearchFilters` field) and six `EXAMPLES` whose Gmail queries come from the real `buildQuery`.
  - Why: resources are how a model reads reference material without calling a tool. The syntax resource lets a model write good queries without guessing.
  - Files: `src/resources/profile.ts`, `src/resources/search-syntax.ts`, `src/tools/with-mailbox.ts`, `src/errors.ts`, `test/resources.test.ts`.
  - Verify: in-memory client `listResources()` and `readResource()`. Inspector shows both under Resources: `mail://search-syntax` renders the markdown with no token; `mail://profile` shows the mailbox JSON with a token and a structured error without one.

- [x] **6.2 Resource templates** (verified 2026-11-03)
  - Build: `mail://message/{message_id}` and `mail://thread/{thread_id}` rendering a `Document` as markdown. Pure renderer `documentToMarkdown` / `threadToMarkdown` in `src/parse/markdown.ts`. Attachments listed only (one provider read per resource), body capped at `MAX_MESSAGE_CHARS`, no `list` callback.
  - Why: templates are parameterised resources. A client can "open" an email by URI.
  - Files: `src/parse/markdown.ts`, `src/resources/message.ts`, `src/resources/thread.ts`, `src/resources/variables.ts`.
  - Verify: Inspector lets you type a message id into the template and shows markdown.

- [x] **6.3 Prompts** (verified 2026-11-03)
  - Build: `build_mail_query`, `collect_for_brief`, `explain_results` exactly as brief section 12 describes. Each file has a pure `render*` plus `register*`; `hints` is one optional free-text string, `today` and `default_window_days` are required strings (MCP prompt arguments are strings); caps (`MAX_COLLECT_MESSAGES`, `MAX_RANGE_DAYS`) are read from config into the text.
  - Why: prompts are server-provided instructions. `collect_for_brief` is the workflow InstantBot's loop will follow.
  - Files: `src/prompts/build-mail-query.ts`, `src/prompts/collect-for-brief.ts`, `src/prompts/explain-results.ts`, `test/prompts.test.ts`.
  - Verify: `getPrompt()` test checks arguments are substituted. Manual: in Claude Code, use the prompt and watch it search, refine, collect, stop.

- [x] **6.4 README and examples** (verified 2026-11-03)
  - Build: README rewritten for a newcomer: pitch, five-minute quickstart, Claude Desktop/Code setup, HTTP setup, the read-only guarantees, tools, filters, the Document shape, the three worked examples (applications against a job description, high priority complaints last week, invoices from one supplier this quarter), resources, prompts, error table, every env var, the ten-step manual walkthrough. `examples/agent-loop.md`: Vercel AI SDK loop using the MCP SDK client directly for tools and the `collect_for_brief` prompt, token minting, failure table.
  - Verify: a reader who has never seen the repo can go from zero to a working `collect_mail` in Inspector following only the README.

- [ ] **6.5 npm publish setup**
  - Build: `prepublishOnly` running `npm run check && npm run build`, `files` whitelist, `npm pack --dry-run` reviewed, version `0.1.0`, GitHub Actions workflow running `npm run check` on push.
  - Verify: `npm pack --dry-run` lists only `dist`, `README.md`, `LICENSE`, `package.json`. CI green.

- [ ] **6.6 Phase 6 docs sync and release**
  - Verify: status shows all six phases done. Tag `v0.1.0`.

- [ ] **6.7 `collect_mail` batch bookmark: `after_message_id`** (added 2026-11-05; independent of 6.5 and 6.6, may be done first)
  - Why: a caller working through a pile in batches ("the 20 oldest, then the next 20 after those") has no way to say where the last batch ended. `oldest_first` already walks and orders the whole id list, then drops everything past `max_messages`.
  - Build: new optional input `after_message_id` (string). The batch starts right after that message in the chosen `order`, with the same filters. The id walk runs until the bookmark is found plus `max_messages` ids past it (`oldest_first` walks to the end as now), capped by `MAX_SEARCH_IDS`. Bookmark not in the walked list: structured `NOT_FOUND` with a hint to re-run without it. Reply gains `next_after_message_id: string | null`: the last id of the batch (returned, failed, or cut by `max_total_chars`; the brief already says those are read one by one with `get_email`), `null` when the walk reached the end. Pure change in `walkIds` plus one result field; no new provider method.
  - Files: `src/tools/collect-mail.ts`, `test/server.test.ts`, `docs/design-brief.md` 8.4, `README.md`, `docs/decisions.md`.
  - Verify: test with a fake provider of 30 messages, `oldest_first`, `max_messages: 10`: three calls chained by `next_after_message_id` return ids 1-10, 11-20, 21-30 and the third has `null`; the same for `newest_first`; an unknown bookmark is `NOT_FOUND`. Manual: in Inspector, collect 5 oldest on one subject, pass the bookmark, see the next 5.

---

## Phase 7 — Later, only when asked

Not planned into tasks. See brief section 12 item 7.
