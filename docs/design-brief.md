# mailsift — design brief

This file is the agreed design for mailsift, an open source MCP server. It was written at the end of a design discussion. Read it fully before doing anything. (The working name during design was `mail-to-docs-mcp`; the package and repo are `mailsift`.)

How to use this file:

1. Read the whole file.
2. Produce an implementation plan that follows the phases in section 12. Do not skip phases or merge them.
3. Build phase by phase. Each phase ends with passing tests and a short manual check.
4. Do not add anything from section 3 "Non-goals". If something seems needed that this file rules out, stop and ask.
5. Keep every name generic. This server is about mail and documents. Never name anything after resumes, candidates, jobs, complaints, or any other single use case. Those appear only as examples in the README.

---

## 1. One-line purpose

A read-only MCP server that turns mailbox content into clean, model-ready documents. Given a filter (subject, sender, dates, keywords, attachments), it returns matching emails as clean text, with attachments converted to text, and a link back to each email. It does no ranking, scoring, or summarising. The app on the other side does the thinking.

Short pitch: Google's Gmail MCP exposes Gmail. This one exposes documents.

## 2. Goals

- Stateless. No database. Every request carries its own credentials in headers (HTTP) or env (stdio).
- Read-only by construction, enforced at several layers (section 7).
- Gmail first, behind a provider interface so IMAP and Microsoft 365 can be added later without changing the tools.
- Tools, resources, and prompts all implemented, so it is a complete MCP server and a good learning project.
- Two transports from one codebase: Streamable HTTP for apps and remote clients, stdio for Claude Code, Cursor, and local agents.
- Hard limits everywhere so a tool reply never blows up a model's context.
- Output shape is always "a document with a reference", so an app can ingest results directly.
- Open source quality: MIT licence, README with three worked examples, tests, Dockerfile, published to npm.

## 3. Non-goals (hard rules)

- No write operations of any kind. No send, reply, draft, label, archive, mark read, delete. No code path for them, ever.
- No LLM calls inside the server. No summarising, no scoring, no "relevance". The server filters by facts only.
- No stored credentials, no account table, no OAuth flow inside the server in version 1. The caller owns the connect flow and token refresh.
- No use-case specific naming or logic.
- No Claude.ai direct connection in version 1 (Claude.ai cannot send custom headers; that needs a stored-account mode, which is a later phase).

## 4. How it fits with the first consumer (InstantBot)

InstantBot is a multi-tenant document platform with a feature called Document Scout: an admin writes a brief, Scout checks each document in a collection against it and returns the ones that fit with quoted evidence. This server feeds Scout with documents pulled from a mailbox. The matching stays in InstantBot. Details in section 13. Nothing in this repo should import from or depend on InstantBot.

## 5. Stack

| Item         | Choice                                                                                                                                                               |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime      | Node.js 20 or newer                                                                                                                                                  |
| Language     | TypeScript, strict                                                                                                                                                   |
| MCP          | `@modelcontextprotocol/sdk` (McpServer, StreamableHTTPServerTransport, StdioServerTransport)                                                                         |
| Schemas      | zod                                                                                                                                                                  |
| HTTP server  | Express (matches the SDK examples)                                                                                                                                   |
| Gmail        | Direct REST calls with `fetch` through one locked client. Do not use the `googleapis` package; it pulls in write methods and makes the allow-list harder to enforce. |
| HTML to text | `html-to-text`                                                                                                                                                       |
| PDF          | `pdf-parse` or `unpdf` (pick one, text extraction only)                                                                                                              |
| DOCX         | `mammoth` (raw text)                                                                                                                                                 |
| Tests        | `vitest`                                                                                                                                                             |
| Build        | `tsup` or plain `tsc`                                                                                                                                                |
| Lint         | eslint + prettier                                                                                                                                                    |
| Licence      | MIT                                                                                                                                                                  |

## 6. Credentials and transports

The server never stores credentials. It reads them per request and forgets them.

### HTTP transport (apps, remote clients)

Every request to the MCP endpoint carries:

| Header                                  | Meaning                                                                                                                                                      |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Authorization: Bearer <server key>`    | Proves the caller may use this server. Keys come from env `MCP_SERVER_KEYS` (comma separated). If the env is empty the server refuses to start in HTTP mode. |
| `X-Mail-Provider: gmail`                | Which provider adapter to use. Default `gmail`.                                                                                                              |
| `X-Mail-Token: <provider access token>` | For Gmail, a Google OAuth access token with the read-only scope. Used for this request only.                                                                 |

Rules:

- Tokens never appear in tool arguments, tool schemas, logs, or error messages.
- Tool handlers read the headers from the request context the SDK passes to handlers (`extra.requestInfo.headers`). Wrap this in one function, `resolveCredentials(extra)`, so a stored-account mode can be added later by changing one place.
- Missing or bad headers produce a structured error (section 10), not a crash.

### stdio transport (Claude Code, Cursor, local scripts)

Credentials come from env:

| Env                                                             | Meaning                                                                                                                                                                                                        |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MAIL_PROVIDER`                                                 | Default `gmail`                                                                                                                                                                                                |
| `MAIL_TOKEN`                                                    | Access token, same as the header                                                                                                                                                                               |
| `GMAIL_REFRESH_TOKEN`, `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET` | Optional local convenience. If set, the server mints access tokens itself and refreshes them in memory, so a local user does not have to paste a new token every hour. In-memory only, never written anywhere. |

Both transports build the same `McpServer` instance. Only the credential source differs.

## 7. Read-only enforcement (all layers required)

1. Scope: the README tells callers to request only `https://www.googleapis.com/auth/gmail.readonly`. Google bakes the scope into the token, so writes fail at Google even if someone bypasses the server.
2. No write code: the Gmail adapter implements only list, get message, get thread, get attachment, get profile.
3. Scope check per request: call `https://oauth2.googleapis.com/tokeninfo?access_token=...`, read the `scope` field, reject the request with `AUTH_SCOPE_TOO_BROAD` if any scope outside an allow-list (`gmail.readonly`, `gmail.metadata`, `userinfo.email`, `openid`) is present. Cache the verdict for 10 minutes keyed by a hash of the token, never by the token itself.
4. Locked HTTP client: one module owns all outbound Gmail traffic. It allows `GET` only and only paths matching an explicit allow-list. Any other call throws before a request is made.
5. Tool annotations: every tool declares `readOnlyHint: true`, `destructiveHint: false`, `openWorldHint: true`.
6. Logging: structured logs with request id, tool name, duration, counts. Redact `Authorization` and `X-Mail-Token` everywhere. Add a test that asserts a token value never appears in captured log output.

## 8. Tools

All tools return `content` as one JSON text block plus a short human summary line. All list-returning tools are paged and capped. All tools accept `max_chars` style caps where text is returned.

### 8.1 `search_mail`

Find messages by facts. Returns metadata only, never bodies.

Input (all optional except at least one filter or `raw_query`):

| Field              | Type                                          | Notes                                                                              |
| ------------------ | --------------------------------------------- | ---------------------------------------------------------------------------------- |
| `subject`          | string                                        | Subject contains                                                                   |
| `from`             | string                                        | Sender address or name                                                             |
| `to`               | string                                        | Recipient address                                                                  |
| `keywords`         | string[]                                      | Words that must appear (body or subject), combined with AND                        |
| `any_keywords`     | string[]                                      | Words where at least one must appear                                               |
| `after`            | date (YYYY-MM-DD)                             | Inclusive                                                                          |
| `before`           | date (YYYY-MM-DD)                             | Exclusive                                                                          |
| `has_attachment`   | boolean                                       |                                                                                    |
| `attachment_types` | ("pdf"\|"docx"\|"txt"\|"md"\|"csv"\|"html")[] | Maps to Gmail `filename:` filters                                                  |
| `label`            | string                                        | Gmail label name                                                                   |
| `raw_query`        | string                                        | Gmail search syntax escape hatch. If given, it is appended to the generated query. |
| `page_size`        | number                                        | Default 25, max 100                                                                |
| `page_token`       | string                                        | From a previous reply                                                              |

Rules: date range wider than `MAX_RANGE_DAYS` (default 365) is rejected with `RANGE_TOO_WIDE`. Spam and trash are excluded always.

Output:

```
{
  "query_used": "subject:(Node) has:attachment filename:pdf after:2026/09/01 before:2026/10/01",
  "result_size_estimate": 43,
  "next_page_token": "…" | null,
  "items": [
    {
      "message_id": "18f…",
      "thread_id": "18f…",
      "date": "2026-09-14T08:12:00Z",
      "from": "Jane Doe <jane@example.com>",
      "to": ["hiring@example.com"],
      "subject": "Application for Senior Node Developer",
      "snippet": "Please find my CV attached…",
      "attachments": [{ "attachment_id": "…", "filename": "jane-cv.pdf", "mime": "application/pdf", "size": 183221 }],
      "link": "https://mail.google.com/mail/u/0/#all/18f…"
    }
  ]
}
```

### 8.2 `get_email`

One message as a clean document.

Input: `message_id` (required), `include_thread` (boolean, default false), `attachments` ("list" | "text" | "none", default "list"), `max_chars` (default 50_000), `max_attachment_chars` (default 100_000).

Output: one Document (section 9).

### 8.3 `get_attachment_text`

Input: `message_id`, `attachment_id` or `filename` (one required), `max_chars` (default 100_000).

Output: `{ "filename", "mime", "size", "text", "truncated": boolean, "pages": number | null }`.

Gmail attachment ids are not guaranteed stable across calls. If `attachment_id` fails with not found, fall back to re-fetching the message and matching by filename.

### 8.4 `collect_mail`

The one-call bundle. Same filter fields as `search_mail` plus:

| Field             | Type                       | Notes                                                     |
| ----------------- | -------------------------- | --------------------------------------------------------- |
| `max_messages`    | number                     | Default 50, hard max `MAX_COLLECT_MESSAGES` (default 200) |
| `include_thread`  | boolean                    | Default false                                             |
| `attachments`     | "text" \| "list" \| "none" | Default "text"                                            |
| `max_total_chars` | number                     | Default 2_000_000. Stop adding documents when reached.    |

Behaviour: search, page until `max_messages` or end, fetch each message, convert, convert attachments, apply caps, return.

Output:

```
{
  "query_used": "…",
  "documents": [ Document, … ],
  "skipped": [ { "message_id": "…", "filename": "big.zip", "reason": "ATTACHMENT_UNSUPPORTED" } ],
  "stats": { "messages_found": 43, "messages_returned": 43, "attachments_returned": 47, "total_chars": 812_331, "truncated": false }
}
```

Fetch messages concurrently with a small limit (default 5) and a short pause on `429`. Retry `429` and `5xx` with backoff, max 3 tries.

### 8.5 `get_mailbox_profile`

Input: none. Output: `{ "email_address", "messages_total", "threads_total", "provider": "gmail", "scopes": [...], "read_only": true }`. This is the "connection test" tool.

## 9. Document shape (the only output shape for mail content)

```
{
  "id": "gmail:18f…",
  "source": "gmail",
  "kind": "email",
  "reference": {
    "message_id": "18f…",
    "thread_id": "18f…",
    "link": "https://mail.google.com/mail/u/0/#all/18f…"
  },
  "headers": {
    "date": "2026-09-14T08:12:00Z",
    "from": "Jane Doe <jane@example.com>",
    "to": ["hiring@example.com"],
    "cc": [],
    "subject": "Application for Senior Node Developer"
  },
  "text": "clean body text, quoted replies and signature removed",
  "thread_text": "optional, all messages in the thread flattened in date order with a separator line per message",
  "attachments": [
    {
      "attachment_id": "…",
      "filename": "jane-cv.pdf",
      "mime": "application/pdf",
      "size": 183221,
      "text": "extracted text or null",
      "truncated": false,
      "skipped_reason": null
    }
  ],
  "truncated": false
}
```

Design note: this shape must stay stable across providers. IMAP and Microsoft 365 adapters produce the same shape with their own `source` and `reference` fields.

## 10. Errors

Return MCP tool errors (`isError: true`) with a JSON body `{ "code", "message", "hint" }`. The `hint` tells a model what to do next. Codes:

| Code                     | When                                        | Hint example                                                     |
| ------------------------ | ------------------------------------------- | ---------------------------------------------------------------- |
| `AUTH_MISSING_TOKEN`     | No mail token in header or env              | "Connect a mailbox and retry"                                    |
| `AUTH_TOKEN_INVALID`     | Google rejects the token (expired, revoked) | "The mailbox token expired. Refresh it and retry"                |
| `AUTH_SCOPE_TOO_BROAD`   | Token has write scopes                      | "Reconnect the mailbox with read-only access only"               |
| `AUTH_SERVER_KEY`        | Bad or missing server key (HTTP)            |                                                                  |
| `QUERY_EMPTY`            | No filter given                             | "Give at least one of subject, from, keywords, dates"            |
| `RANGE_TOO_WIDE`         | Date range over the limit                   | "Narrow the date range to at most 365 days"                      |
| `NOT_FOUND`              | Message or attachment missing               |                                                                  |
| `ATTACHMENT_UNSUPPORTED` | Type not parseable or too large             | "Skipped. Supported: pdf, docx, txt, md, csv, html, up to 10 MB" |
| `RATE_LIMITED`           | Google 429 after retries                    | "Wait a minute and retry with a smaller page_size"               |
| `PROVIDER_ERROR`         | Anything else from Google                   |                                                                  |

## 11. Text cleaning rules

Bodies:

- Prefer `text/plain` part. If only `text/html`, convert with `html-to-text` (no images, links kept as `text (url)`).
- Remove quoted replies: lines starting with `>`, blocks after `On <date>, <name> wrote:`, Gmail's `gmail_quote` div, Outlook's `From: … Sent: …` header blocks.
- Remove signatures after a `-- ` line or common sign-off patterns, but keep them if the remaining text would be under 200 chars.
- Collapse more than two blank lines. Trim.
- Thread flattening: messages ordered by date, each prefixed by `--- From <from> on <date> ---`, each cleaned the same way.

Attachments:

- Supported: `application/pdf`, `.docx`, `text/plain`, `text/markdown`, `text/csv`, `text/html`.
- Skip with `ATTACHMENT_UNSUPPORTED` when: size over `MAX_ATTACHMENT_BYTES` (default 10 MB), unsupported type, inline images, or a parse failure (report `PARSE_FAILED` as the reason, never throw for the whole call).
- PDF with no extractable text (scanned) returns empty text and reason `NO_TEXT_LAYER`. OCR is out of scope for version 1.
- Per-attachment char cap applied after extraction, with `truncated: true`.

Everything in this section is pure functions with fixture-based unit tests.

## 12. Resources, prompts, and build phases

### Resources

| URI                           | Content                                                                        |
| ----------------------------- | ------------------------------------------------------------------------------ |
| `mail://profile`              | Same as `get_mailbox_profile`                                                  |
| `mail://search-syntax`        | Markdown: every filter field, how it maps to Gmail syntax, six worked examples |
| `mail://message/{message_id}` | Resource template, one Document as markdown                                    |
| `mail://thread/{thread_id}`   | Resource template, flattened thread as markdown                                |

### Prompts

| Name                | Arguments                                                  | What it instructs                                                                                                                                                                                                                                                         |
| ------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `build_mail_query`  | `request` (plain sentence), `today`, `default_window_days` | Turn a plain request into `search_mail` fields. Prefer facts (subject words, sender, dates, attachment types). Never invent a sender. If nothing to filter on, say what is missing.                                                                                       |
| `collect_for_brief` | `brief`, `hints` (optional subject, sender, dates)         | The workflow: search, inspect count and subjects, refine at most twice (narrow if over cap, widen if under 3), then `collect_mail`, then stop. Never call anything that is not listed. If still unsure after two refinements, report what was found and ask one question. |
| `explain_results`   | none                                                       | Describe a `collect_mail` reply in plain words: how many, what was skipped and why, the query used.                                                                                                                                                                       |

### Build phases (do them in order)

1. Scaffold. Repo layout (section 14), TypeScript, eslint, vitest, `McpServer` with `get_mailbox_profile` only, stdio transport, env credentials. Manual check with MCP Inspector and a real token from Google OAuth Playground.
2. Gmail adapter + `search_mail` + `get_email` (bodies only). Locked client with allow-list. Scope check. Error model. Recorded-response fixtures for tests.
3. Text cleaning and attachments. `get_attachment_text`. All of section 11 with fixtures (sample HTML bodies, quoted replies, a PDF, a DOCX).
4. `collect_mail` with concurrency, retries, caps, `skipped` and `stats`.
5. HTTP transport with server keys and header credentials. Health route. Redacted logging and the no-token-in-logs test. Dockerfile.
6. Resources and prompts. README with three examples (resumes against a job description, high priority complaints in the last week, invoices from one supplier this quarter). npm publish setup.
7. Later, only when asked: IMAP adapter with app password (fetch with `BODY.PEEK`, never marks read), Microsoft 365 adapter, stored-account mode with OAuth login for Claude.ai direct connection, spreadsheet attachments, OCR.

## 13. InstantBot integration (for reference only, not built in this repo)

Written here so the server is designed with its first consumer in mind. Build this in the InstantBot repo later.

- Settings. New "Mailbox" section under Settings, Integrations. "Connect mailbox" button starts Google OAuth with the read-only scope, offline access, forced consent, and a signed state bound to the tenant. The callback exchanges the code, stores the refresh token encrypted using the existing `packages/platform-core/src/channels/credentials-crypto.ts`, plus the email address and granted scopes, on the tenant. Disconnect revokes at Google and deletes the row. Pattern to copy: `services/platform-api/src/routes/v1/whatsapp-settings.routes.ts` and its controller/service/validator siblings.
- Google Cloud. InstantBot's own project, Gmail API enabled, consent screen with the single read-only scope. Testing mode allows up to 100 test users with no review. Public production use of the restricted Gmail scope needs Google verification plus a yearly third-party security assessment.
- Worker step "mail intake". A new worker step before extraction and matching. It runs a small agent loop: open an MCP client to the server over HTTP with `Authorization` (server key) and `X-Mail-Token` (a fresh Google access token minted from the tenant's refresh token, cached in memory about 55 minutes); fetch the tool list; give Gemini the admin's sentence, the `collect_for_brief` prompt, and the tools as function declarations; let the model search, refine at most twice, and collect; save the returned documents into the collection; then the existing Scout path ranks them against the brief. The worker already uses the Vercel AI SDK (`services/ingestion-worker/src/lib/extraction-llm.ts`), which has tool calling and an MCP client, so no new LLM plumbing is needed.
- Guard rails in the loop. Max turns, max messages, max tokens. Every tool call written to the job log in plain words ("Searched: subject has Node, has attachment, 1 Jul to 22 Oct"). Unknown tool names refused. Off-topic or write requests end the job with a one-line refusal. If the pile is still unclear after two refinements, the job pauses with a question for the admin. Scout never runs on a partial pile.
- Env in InstantBot: `MAIL_MCP_URL`, `MAIL_MCP_KEY`, `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_OAUTH_REDIRECT_URL`.
- Document kinds. Resumes arrive as attachment documents. Complaints arrive as email body documents. Same path, different brief.

## 14. Repo layout

```
mailsift/
  src/
    index.ts                 # CLI entry: --stdio (default) | --http
    server.ts                # builds McpServer: registers tools, resources, prompts
    config.ts                # env + limits with defaults
    errors.ts                # error codes + toToolError()
    logging.ts               # structured logger with redaction
    auth/
      credentials.ts         # resolveCredentials(extra) for http and stdio
      scope-check.ts         # tokeninfo call + cache
      server-keys.ts         # bearer key check for http
    providers/
      types.ts               # MailProvider interface + Document types
      gmail/
        client.ts            # locked GET-only fetch with path allow-list
        provider.ts          # search, getMessage, getThread, getAttachment, profile
        query-builder.ts     # filter fields -> Gmail q string
        mime.ts              # part walking, base64url decode
    parse/
      document.ts            # RawMessage -> Document (section 9), pure (added 2026-10-28, see decisions.md)
      html-to-text.ts
      quotes.ts              # quoted reply + signature stripping
      thread.ts              # flattening
      attachments/
        index.ts             # dispatch by mime
        pdf.ts
        docx.ts
        text.ts
    tools/                   # one file per tool, plus shared helpers:
      with-mailbox.ts        #   credentials -> scope check -> provider -> error mapping (added 2026-10-27, see decisions.md)
      args.ts                #   optional-argument normalising (added 2026-10-28, see decisions.md)
      attachment-texts.ts    #   fetch + parse every attachment of a message (added 2026-10-28, see decisions.md)
      result.ts              #   the two-block tool reply
    resources/               # one file per resource
    prompts/                 # one file per prompt
    transports/
      stdio.ts
      http.ts                # express app, /mcp, /healthz
  test/
    fixtures/                # html bodies, quoted replies, sample.pdf, sample.docx, recorded gmail json
    *.test.ts
  examples/
    claude-code.md           # stdio config snippet
    curl-http.md             # header example
    agent-loop.md            # minimal client loop with the Vercel AI SDK
  Dockerfile
  README.md
  LICENSE
  package.json
```

## 15. Limits (env, with defaults)

| Env                    | Default  |
| ---------------------- | -------- |
| `MAX_RANGE_DAYS`       | 365      |
| `MAX_PAGE_SIZE`        | 100      |
| `MAX_COLLECT_MESSAGES` | 200      |
| `MAX_ATTACHMENT_BYTES` | 10485760 |
| `MAX_MESSAGE_CHARS`    | 50000    |
| `MAX_ATTACHMENT_CHARS` | 100000   |
| `MAX_TOTAL_CHARS`      | 2000000  |
| `FETCH_CONCURRENCY`    | 5        |
| `GMAIL_TIMEOUT_MS`     | 20000    |
| `SCOPE_CACHE_TTL_MS`   | 600000   |

## 16. Testing and verification

- Unit: query builder (fields to Gmail string, including escaping), cleaning rules with fixtures, attachment parsers with a real small PDF and DOCX, error mapping, scope check allow-list, locked client refuses non-GET and unknown paths, logger redaction.
- Provider: Gmail adapter tested against recorded JSON responses, no network.
- Integration (manual, documented in README): get a read-only token from Google OAuth Playground with your own Google Cloud client, run `npx mailsift --stdio` with `MAIL_TOKEN`, open MCP Inspector, call `get_mailbox_profile`, `search_mail`, `collect_mail`. Then run `--http`, call with curl and the two headers.
- Definition of done per phase: `npm run lint && npm run typecheck && npm test` green, plus the manual check for that phase.

## 17. Gmail facts the implementation relies on

- REST base: `https://gmail.googleapis.com/gmail/v1/users/me/`. Endpoints used: `profile`, `messages?q=&maxResults=&pageToken=`, `messages/{id}?format=full`, `threads/{id}?format=full`, `messages/{id}/attachments/{attachmentId}`.
- Attachment and body data are base64url.
- Search operators used by the query builder: `subject:`, `from:`, `to:`, `after:YYYY/MM/DD`, `before:YYYY/MM/DD`, `has:attachment`, `filename:`, `label:`, `-in:spam -in:trash`, quoted phrases, `OR`, `{}` groups.
- API is free. Quota is 1,000,000,000 units per project per day and 250 units per user per second. List, get, and attachment calls cost 5 units each.
- Scope check endpoint: `https://oauth2.googleapis.com/tokeninfo?access_token=<token>`.
- Link format for a message: `https://mail.google.com/mail/u/0/#all/<message_id>`.
