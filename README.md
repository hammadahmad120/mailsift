# mailsift

Your mailbox, as documents your AI can actually read. Read-only MCP server that searches mail and returns clean text with attachments extracted.

> Status: early. Five tools (`get_mailbox_profile`, `search_mail`, `get_email`, `get_attachment_text`, `collect_mail`) over stdio. Bodies come out clean (HTML converted, quoted replies and signatures removed) and attachments can be returned as text. `get_attachment_file` and HTTP are in progress. See [docs/status.md](docs/status.md) for the phase tracker and [docs/design-brief.md](docs/design-brief.md) for the full design.

## Development

Requires Node 22 or newer for development (runtime target is Node 20+).

```
npm install
npm run check     # lint + typecheck + test
npm run dev       # run from source
npm run build     # build to dist/
```

Copy `.env.example` to `.env` for local configuration. Never commit tokens.

## Run it

```
MAIL_TOKEN=<read-only Gmail access token> npm run dev            # stdio, for Claude Code, Cursor, Inspector
npx @modelcontextprotocol/inspector -e MAIL_TOKEN=<token> npx tsx src/index.ts
```

How to get a token and how to add the server to Claude Code: [examples/claude-code.md](examples/claude-code.md). The `--http` transport is not built yet.

## Tools

| Tool                  | What it does                                                                                                                                                                                                                                                                                                                                                                    |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `get_mailbox_profile` | Connection test. Email address, message and thread counts, granted scopes, `read_only: true`.                                                                                                                                                                                                                                                                                   |
| `search_mail`         | Find messages by `subject`, `from`, `to`, `keywords`, `any_keywords`, `after`, `before`, `has_attachment`, `attachment_types`, `label`, `raw_query`. Metadata and links only, never bodies. Paged with `page_size` and `page_token`.                                                                                                                                            |
| `get_email`           | Read one message by `message_id` as a document: headers, body text, attachment list, link. `include_thread: true` adds the whole conversation as `thread_text`. `attachments: "text"` extracts each attachment inline. `max_chars` caps the body (default 50000).                                                                                                               |
| `get_attachment_text` | One attachment as text by `message_id` plus `filename` (preferred) or `attachment_id`. PDF, DOCX, TXT, MD, CSV, HTML. A file it cannot read comes back with `skipped_reason`, never an error for the whole call.                                                                                                                                                                |
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
