# mailsift

Your mailbox, as documents your AI can actually read. Read-only MCP server that searches mail and returns clean text with attachments extracted.

> Status: early. Six tools (`get_mailbox_profile`, `search_mail`, `get_email`, `get_attachment_text`, `get_attachment_file`, `collect_mail`) over stdio and over HTTP. Bodies come out clean (HTML converted, quoted replies and signatures removed) and attachments can be returned as text or as the original file. Resources, prompts and the npm release are next. See [docs/status.md](docs/status.md) for the phase tracker and [docs/design-brief.md](docs/design-brief.md) for the full design.

## Development

Requires Node 22 or newer for development (runtime target is Node 20+).

```
npm install
npm run check     # lint + typecheck + test
npm run dev       # run from source
npm run build     # build to dist/
```

Copy `.env.example` to `.env` for local configuration and run with `npm run dev:env -- [--http]`, which loads it through Node's `--env-file`. Never commit tokens; `.env` is git-ignored.

## Run it

### stdio (Claude Code, Cursor, Inspector, local scripts)

```
MAIL_TOKEN=<read-only Gmail access token> npm run dev
npx @modelcontextprotocol/inspector -e MAIL_TOKEN=<token> npx tsx src/index.ts
```

The client launches the server as a child process, so the mailbox credentials come from the environment: `MAIL_TOKEN`, or the refresh trio `GMAIL_REFRESH_TOKEN`, `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET` for a token that renews itself. How to get a token and add the server to Claude Code: [examples/claude-code.md](examples/claude-code.md).

### HTTP (apps, remote clients, containers)

```
MCP_SERVER_KEYS=<key>[,<key>] PORT=3000 HOST=127.0.0.1 npm run dev -- --http   # development
MCP_SERVER_KEYS=<key> node dist/index.js --http                               # after npm run build
docker build -t mailsift . && docker run -e MCP_SERVER_KEYS=<key> -p 3000:3000 mailsift
```

`POST /mcp` carries two credentials on every request: `Authorization: Bearer <server key>` (one of `MCP_SERVER_KEYS`, generate with `openssl rand -hex 32`) and `X-Mail-Token: <access token>` (the mailbox, this request only; optional `X-Mail-Provider`, default `gmail`). MCP also requires `Accept: application/json, text/event-stream`. `GET /healthz` is open. The server is stateless, answers plain JSON, never reads mailbox credentials from its own environment over HTTP, refuses to start without a server key, and stops cleanly on `SIGTERM`. curl walkthrough: [examples/curl-http.md](examples/curl-http.md).

### Environment variables

| Variable                                                                                                                                                                                                                           | Default            | Used by                                |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ | -------------------------------------- |
| `MAIL_TOKEN`, `GMAIL_REFRESH_TOKEN`, `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `MAIL_PROVIDER`                                                                                                                                     | none               | stdio only                             |
| `MCP_SERVER_KEYS`                                                                                                                                                                                                                  | none               | HTTP, required, comma separated        |
| `PORT`, `HOST`                                                                                                                                                                                                                     | 3000, 0.0.0.0      | HTTP                                   |
| `LOG_LEVEL`                                                                                                                                                                                                                        | info               | both; `debug`, `info`, `warn`, `error` |
| `MAX_RANGE_DAYS`, `MAX_PAGE_SIZE`, `MAX_COLLECT_MESSAGES`, `MAX_SEARCH_IDS`, `MAX_ATTACHMENT_BYTES`, `MAX_MESSAGE_CHARS`, `MAX_ATTACHMENT_CHARS`, `MAX_TOTAL_CHARS`, `FETCH_CONCURRENCY`, `GMAIL_TIMEOUT_MS`, `SCOPE_CACHE_TTL_MS` | see `.env.example` | both, caps and timeouts                |

Logs are JSON lines on stderr, never stdout: one per HTTP request (`request_id`, method, path, status, duration) and one per tool call (tool, `rpc_id`, duration, error code), sharing the `request_id` that is also returned in the `X-Request-Id` header. Tokens, keys and `Authorization` / `X-Mail-Token` values are redacted before anything is written.

## Resources

Two documents a client can list and open without calling a tool:

- `mail://profile`: the connected mailbox, same JSON as `get_mailbox_profile`. Needs the mailbox credentials.
- `mail://search-syntax`: markdown explaining every `search_mail` and `collect_mail` filter, the Gmail syntax it becomes, the rules, and six worked examples. Generated from the query builder, so it always matches the code. Read it before writing a query. Needs no credentials.

In MCP Inspector they appear under **Resources**. A resource read that fails returns a JSON-RPC error whose `data` holds the same `{ code, message, hint }` body the tools use.

## Tools

| Tool                  | What it does                                                                                                                                                                                                                                                                                                                                                                    |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `get_mailbox_profile` | Connection test. Email address, message and thread counts, granted scopes, `read_only: true`.                                                                                                                                                                                                                                                                                   |
| `search_mail`         | Find messages by `subject`, `from`, `to`, `keywords`, `any_keywords`, `after`, `before`, `has_attachment`, `attachment_types`, `label`, `raw_query`. Metadata and links only, never bodies. Paged with `page_size` and `page_token`.                                                                                                                                            |
| `get_email`           | Read one message by `message_id` as a document: headers, body text, attachment list, link. `include_thread: true` adds the whole conversation as `thread_text`. `attachments: "text"` extracts each attachment inline. `max_chars` caps the body (default 50000).                                                                                                               |
| `get_attachment_text` | One attachment as text by `message_id` plus `filename` (preferred) or `attachment_id`. PDF, DOCX, TXT, MD, CSV, HTML. A file it cannot read comes back with `skipped_reason`, never an error for the whole call.                                                                                                                                                                |
| `get_attachment_file` | The original attachment bytes by `message_id` plus `filename` or `attachment_id`, for apps that store the file as sent. Metadata JSON plus a base64 resource block with the mime type. Files over `MAX_ATTACHMENT_BYTES` (default 10 MB) are refused with `ATTACHMENT_UNSUPPORTED`.                                                                                             |
| `collect_mail`        | Everything matching the filters as clean documents in one call. Same filters as `search_mail` plus `max_messages` (default 50, cap 200), `order` (`newest_first` default, or `oldest_first` for a backlog), `include_thread`, `attachments` (`text` default), `max_total_chars` (default 2000000). Replies with `documents`, `skipped` (what was left out and why) and `stats`. |

Example `search_mail` call and reply:

```json
{ "subject": "Node developer", "after": "2026-09-01", "attachment_types": ["pdf"] }
```

```json
{
  "query_used": "subject:(Node developer) after:2026/09/01 filename:pdf -in:spam -in:trash",
  "result_size_estimate": 43,
  "next_page_token": "…",
  "items": [
    {
      "message_id": "18f…",
      "thread_id": "18f…",
      "date": "2026-09-14T08:12:00.000Z",
      "from": "Jane Doe <jane@example.com>",
      "to": ["hiring@example.com"],
      "subject": "Application for Senior Node Developer",
      "snippet": "Please find my CV attached…",
      "attachments": [
        {
          "attachment_id": "…",
          "filename": "jane-cv.pdf",
          "mime": "application/pdf",
          "size": 183221
        }
      ],
      "link": "https://mail.google.com/mail/u/0/#all/18f…"
    }
  ]
}
```

Every filter is optional but at least one of subject, from, to, keywords, dates, label or raw_query must be set. Date ranges wider than `MAX_RANGE_DAYS` (default 365) are rejected. Spam and trash are always excluded.

Example `collect_mail` call and the shape of its reply:

```json
{
  "from": "supplier@example.com",
  "after": "2026-07-01",
  "before": "2026-10-01",
  "attachment_types": ["pdf"],
  "order": "oldest_first"
}
```

```json
{
  "query_used": "from:(supplier@example.com) after:2026/07/01 before:2026/10/01 filename:pdf -in:spam -in:trash",
  "documents": [
    {
      "id": "gmail:18f…",
      "headers": { "subject": "Invoice 2026-0712" },
      "text": "…",
      "attachments": [{ "filename": "invoice-0712.pdf", "text": "…" }]
    }
  ],
  "skipped": [
    { "message_id": "18f…", "filename": "statement.zip", "reason": "ATTACHMENT_UNSUPPORTED" }
  ],
  "stats": {
    "messages_found": 14,
    "messages_returned": 14,
    "attachments_returned": 13,
    "total_chars": 48210,
    "truncated": false
  }
}
```

When a cap cuts the result, `stats.truncated` is true and every message left out by `max_total_chars` is listed in `skipped` with reason `MAX_TOTAL_CHARS`, so it can still be read with `get_email`.

## Licence

MIT
