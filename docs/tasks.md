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

- [ ] **3.5 Attachment parsers**
  - Build: `parseAttachment({ mime, filename, bytes })` dispatching to `text.ts` (txt, md, csv, html), `pdf.ts` (unpdf, reports `pages`, `NO_TEXT_LAYER` for scans), `docx.ts` (mammoth raw text). Size cap, unsupported types and parse failures return `{ skipped_reason }` and never throw.
  - Why: pure functions, every failure is a value, so one bad file never breaks a 50-message collect.
  - Files: `src/parse/attachments/{index,text,pdf,docx}.ts`, `test/fixtures/attachments/sample.pdf`, `sample.docx`, `scanned.pdf`, `sample.csv`, `test/attachments.test.ts`.
  - Verify: tests extract known sentences from the sample PDF and DOCX, scanned PDF gives `NO_TEXT_LAYER`, a `.zip` gives `ATTACHMENT_UNSUPPORTED`, an 11 MB buffer gives `ATTACHMENT_UNSUPPORTED`, a corrupted PDF gives `PARSE_FAILED`.

- [ ] **3.6 Gmail provider: getAttachment**
  - Build: `getAttachment(messageId, attachmentId)` returning bytes, via the locked client.
  - Files: `src/providers/gmail/provider.ts`, `test/fixtures/gmail/attachment.json`.
  - Verify: test decodes the recorded base64url into the expected byte length.

- [ ] **3.7 `get_attachment_text` tool**
  - Build: tool accepting `attachment_id` or `filename`, with the filename fallback when the id is stale.
  - Files: `src/tools/get-attachment-text.ts`, `test/server.test.ts`.
  - Verify: test simulates a stale id (`NOT_FOUND`) and sees the fallback succeed by filename. Manual: pull a real PDF's text in Inspector.

- [ ] **3.8 Wire cleaning and attachments into `get_email`**
  - Build: `get_email` now returns cleaned `text`, honours `attachments: "text" | "list" | "none"`, and `max_attachment_chars`.
  - Verify: Inspector shows a reply email with the quoted history gone and the PDF text inline.

- [ ] **3.9 Phase 3 docs sync**

---

## Phase 4 — `collect_mail`

Goal: one call that returns a whole pile of documents under hard caps.

- [ ] **4.1 Concurrency limiter**
  - Build: a tiny `pLimit(n)` helper, no dependency.
  - Files: `src/util/concurrency.ts`, `test/concurrency.test.ts`.
  - Verify: test proves at most `n` tasks run at once.

- [ ] **4.2 `collect_mail` tool**
  - Build: search and page until `max_messages`, fetch with `FETCH_CONCURRENCY`, convert, apply `max_total_chars`, fill `skipped` and `stats`.
  - Files: `src/tools/collect-mail.ts`, `test/server.test.ts`.
  - Open question (raised 2026-10-23, decide when this task starts): message order when the cap truncates. Gmail lists newest first, which drops the oldest messages from a queue. Proposal: `order: "oldest_first" | "newest_first"` field, walk list ids to the end, reverse, take `max_messages`, plus a `MAX_SEARCH_IDS` config cap. `search_mail` keeps Gmail order.
  - Verify: test with a fake provider of 30 messages and `max_total_chars` small enough to cut off at 10 checks `stats.truncated: true` and `messages_returned: 10`. Manual: collect last month's mail with attachments in Inspector, read the stats block.

- [ ] **4.3 Phase 4 docs sync**

---

## Phase 5 — HTTP transport

Goal: the same server reachable over a URL with two headers, safe to run in Docker.

- [ ] **5.1 Logger with redaction**
  - Build: structured JSON logger to stderr with request id, tool name, duration, counts. Redacts `Authorization`, `X-Mail-Token`, and any value that looks like a bearer token.
  - Files: `src/logging.ts`, `test/logging.test.ts`.
  - Verify: the brief's required test: log an object containing a token value, capture output, assert the token string is absent.

- [ ] **5.2 Server key check**
  - Build: `assertServerKey(headers)` comparing `Authorization: Bearer` against `MCP_SERVER_KEYS` using constant-time comparison. `AUTH_SERVER_KEY` on failure. Server refuses to start in HTTP mode if the env is empty.
  - Files: `src/auth/server-keys.ts`, `test/server-keys.test.ts`.

- [ ] **5.3 Header credentials**
  - Build: `resolveCredentials(extra)` gains the HTTP branch reading `X-Mail-Provider` and `X-Mail-Token` from `extra.requestInfo.headers`.
  - Why: the one-place rule from task 1.4 pays off here.
  - Verify: tests cover env, headers, and header-over-env precedence.

- [ ] **5.4 Express app with Streamable HTTP**
  - Build: `POST /mcp` using `StreamableHTTPServerTransport` in stateless mode (new transport per request, no sessions, which matches "stateless" in the brief), `GET /healthz`. Server key checked before the transport sees the request.
  - Why: this is the transport apps and InstantBot will use. Stateless means any replica can serve any request.
  - Files: `src/transports/http.ts`, `test/http.test.ts`, `examples/curl-http.md`.
  - Verify: supertest-style test posts an `initialize` and a `tools/list` and gets JSON back; a request without the server key gets 401. Manual: `npm run dev -- --http`, then the curl commands from `examples/curl-http.md`.

- [ ] **5.5 CLI `--http` and Dockerfile**
  - Build: `index.ts` wires `--http`, reads `PORT`. Multi-stage Dockerfile on `node:20-alpine`, non-root user, `HEALTHCHECK` on `/healthz`.
  - Verify: `docker build -t mailsift .` then `docker run -e MCP_SERVER_KEYS=dev -p 3000:3000 mailsift` and curl `/healthz`.

- [ ] **5.6 Phase 5 docs sync**

---

## Phase 6 — Resources, prompts, README, publish

Goal: a complete MCP server and a repo someone else can use.

- [ ] **6.1 Static resources**
  - Build: `mail://profile` (same as the tool) and `mail://search-syntax` (markdown generated from the query builder's field list, six examples).
  - Why: resources are how a model reads reference material without calling a tool. The syntax resource lets a model write good queries without guessing.
  - Files: `src/resources/profile.ts`, `src/resources/search-syntax.ts`, `test/resources.test.ts`.
  - Verify: in-memory client `listResources()` and `readResource()`. Inspector shows both under Resources.

- [ ] **6.2 Resource templates**
  - Build: `mail://message/{message_id}` and `mail://thread/{thread_id}` rendering a `Document` as markdown.
  - Why: templates are parameterised resources. A client can "open" an email by URI.
  - Files: `src/resources/message.ts`, `src/resources/thread.ts`.
  - Verify: Inspector lets you type a message id into the template and shows markdown.

- [ ] **6.3 Prompts**
  - Build: `build_mail_query`, `collect_for_brief`, `explain_results` exactly as brief section 12 describes.
  - Why: prompts are server-provided instructions. `collect_for_brief` is the workflow InstantBot's loop will follow.
  - Files: `src/prompts/*.ts`, `test/prompts.test.ts`.
  - Verify: `getPrompt()` test checks arguments are substituted. Manual: in Claude Code, use the prompt and watch it search, refine, collect, stop.

- [ ] **6.4 README and examples**
  - Build: README with install, the read-only scope instruction, both transports, all env vars, every tool with a short example, the three worked examples (resumes against a job description, high priority complaints last week, invoices from one supplier this quarter), and the manual verification walkthrough. `examples/agent-loop.md` with a minimal Vercel AI SDK loop.
  - Verify: a reader who has never seen the repo can go from zero to a working `collect_mail` in Inspector following only the README.

- [ ] **6.5 npm publish setup**
  - Build: `prepublishOnly` running `npm run check && npm run build`, `files` whitelist, `npm pack --dry-run` reviewed, version `0.1.0`, GitHub Actions workflow running `npm run check` on push.
  - Verify: `npm pack --dry-run` lists only `dist`, `README.md`, `LICENSE`, `package.json`. CI green.

- [ ] **6.6 Phase 6 docs sync and release**
  - Verify: status shows all six phases done. Tag `v0.1.0`.

---

## Phase 7 — Later, only when asked

Not planned into tasks. See brief section 12 item 7.
