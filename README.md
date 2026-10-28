# mailsift

Your mailbox, as documents your AI can actually read. Read-only MCP server that searches mail and returns clean text with attachments extracted.

> Status: early. Four tools (`get_mailbox_profile`, `search_mail`, `get_email`, `get_attachment_text`) over stdio. Bodies come out clean (HTML converted, quoted replies and signatures removed) and attachments can be returned as text. `collect_mail` and HTTP are in progress. See [docs/status.md](docs/status.md) for the phase tracker and [docs/design-brief.md](docs/design-brief.md) for the full design.

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

| Tool                  | What it does                                                                                                                                                                                                                         |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `get_mailbox_profile` | Connection test. Email address, message and thread counts, granted scopes, `read_only: true`.                                                                                                                                        |
| `search_mail`         | Find messages by `subject`, `from`, `to`, `keywords`, `any_keywords`, `after`, `before`, `has_attachment`, `attachment_types`, `label`, `raw_query`. Metadata and links only, never bodies. Paged with `page_size` and `page_token`. |
| `get_email`           | Read one message by `message_id` as a document: headers, body text, attachment list, link. `include_thread: true` adds the whole conversation as `thread_text`. `max_chars` caps the body (default 50000).                           |

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

## Licence

MIT
