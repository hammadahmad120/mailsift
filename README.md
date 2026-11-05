# mailsift

Read-only MCP server for your mailbox. It searches mail and hands back clean, model-ready documents: the body with quoted replies and signatures stripped, attachments as text, and a link back to the original.

Gmail today. The provider interface is there for IMAP and Microsoft 365 later.

It cannot send, label, archive, or delete anything. There is no code path for that, not a flag that turns it off.

```
npx @modelcontextprotocol/inspector -e MAIL_TOKEN=<read-only Gmail token> npx mailsift
```

## What it is for

You have a mailbox with things in it that an AI should read: applications with CVs attached, supplier paperwork, customer complaints, weekly reports, whatever lands in your inbox. Raw Gmail API output is a bad fit for a model. It is nested MIME, base64 bodies, HTML with six levels of quoted history, and attachments as opaque ids.

mailsift sits between the model and the mailbox and does the boring part:

- Finds messages by subject, sender, date, keywords, label, or attachment type.
- Converts HTML to text, drops the quoted history and the signature.
- Pulls text out of PDF, DOCX, TXT, MD, CSV and HTML attachments.
- Returns everything in one stable JSON shape called a Document.
- Does the whole search-then-fetch loop in a single call with `collect_mail`, with caps so a model cannot ask for a hundred thousand messages by accident.

Two ways to use it:

- **In a chat client** such as Claude Desktop, Claude Code, Cursor, or anything that speaks MCP over stdio. Add it, connect a mailbox, ask questions about your mail.
- **From your own app** over HTTP. Your backend gets a model, hands it mailsift's tools, and lets the model search and collect. Each request carries its own mailbox token, so one server can serve many mailboxes.

## Try it in five minutes

You need Node 20 or newer and a Google account.

**1. Get a read-only token.** Open [Google's OAuth Playground](https://developers.google.com/oauthplayground). In step 1 find Gmail API v1 and tick only `https://www.googleapis.com/auth/gmail.readonly`. Authorize, sign in, then in step 2 click "Exchange authorization code for tokens" and copy the access token. It lasts about an hour.

Only tick the read-only scope. mailsift checks the token's scopes before it touches mail and refuses anything broader.

**2. Open it in MCP Inspector.**

```
npx @modelcontextprotocol/inspector -e MAIL_TOKEN=<token> npx mailsift
```

Or from a clone of this repo:

```
npm install
npx @modelcontextprotocol/inspector -e MAIL_TOKEN=<token> npx tsx src/index.ts
```

Open the URL it prints, click Connect, then Tools.

**3. Call three tools.**

- `get_mailbox_profile` with no arguments. You get your address, message count, and `read_only: true`.
- `search_mail` with `{ "subject": "<a word from a subject in your inbox>" }`. You get matching messages with ids and links, no bodies.
- `collect_mail` with the same filter. You get the matching messages as documents, bodies cleaned, attachments extracted, plus a `stats` block saying how many were found and whether any cap cut the result.

That is the whole product. Everything below is detail.

## Use it with Claude Desktop or Claude Code

Both launch the server as a child process and talk to it over stdin and stdout. The mailbox token comes from the environment.

Claude Code, from the command line:

```
claude mcp add mailsift -e MAIL_TOKEN=<token> -- npx mailsift
```

Or in a project `.mcp.json`. The `${MAIL_TOKEN}` form reads the variable from your shell at launch so no token lands in the file:

```json
{
  "mcpServers": {
    "mailsift": {
      "command": "npx",
      "args": ["mailsift"],
      "env": { "MAIL_TOKEN": "${MAIL_TOKEN}" }
    }
  }
}
```

Claude Desktop uses the same JSON shape in its `claude_desktop_config.json`.

Then ask things like:

- "Which mailbox is connected and how many messages does it have?"
- "Find everything from billing@example.com since September with a PDF attached and summarise each one."
- "Open `mail://thread/<id>` and tell me what was agreed."

The server ships a prompt called `collect_for_brief` that appears as a slash command. Give it a brief such as "weekly reports from the team this quarter" and it walks the model through searching, narrowing or widening at most twice, collecting, and stopping.

For a token that renews itself instead of expiring hourly, set `GMAIL_REFRESH_TOKEN`, `GMAIL_CLIENT_ID` and `GMAIL_CLIENT_SECRET` from your own Google Cloud OAuth client. The server mints access tokens in memory and re-mints before expiry. More in [examples/claude-code.md](examples/claude-code.md).

## Use it from your own app over HTTP

Run the server once, somewhere your services can reach it:

```
MCP_SERVER_KEYS=<key> node dist/index.js --http
# or
docker build -t mailsift . && docker run -e MCP_SERVER_KEYS=<key> -p 3000:3000 mailsift
```

Every `POST /mcp` carries two headers:

| Header                               | Purpose                                                                                                        |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| `Authorization: Bearer <server key>` | Proves the caller may use this server. One of the comma-separated `MCP_SERVER_KEYS`. Make one per service.     |
| `X-Mail-Token: <access token>`       | The mailbox to read, for this request only. The server never reads a mailbox token from its own env over HTTP. |

Plus `Accept: application/json, text/event-stream`, which MCP requires. Replies are plain JSON. There are no sessions; every request stands alone. `GET /healthz` is open for load balancers.

The usual loop in your backend: connect, fetch the tool list, fetch the `collect_for_brief` prompt with the user's brief filled in, give both to your model, let it call tools until it stops, store the documents it collected. A complete example with the Vercel AI SDK is in [examples/agent-loop.md](examples/agent-loop.md). Raw curl calls are in [examples/curl-http.md](examples/curl-http.md).

Where the mail token comes from in this setup: your app holds the user's Google refresh token, mints a short-lived access token from it, and sends that. mailsift never sees the refresh token and stores nothing.

## Why you can trust it with a mailbox

- **GET only.** The Gmail client allows `GET` against a short allow-list of paths. A `POST` or `DELETE` is refused by name before any request is built. There is no code that could send or modify mail.
- **Scope check first.** Before the first mail call the server asks Google what scopes the token carries. Anything beyond `gmail.readonly` is rejected with `AUTH_SCOPE_TOO_BROAD`.
- **Nothing stored.** No database, no file cache, no token on disk. Over HTTP each request's token lives for that request.
- **No tokens in logs.** Logs are JSON lines on stderr. Field names such as `authorization` and `x_mail_token` are blanked, and values that look like Google tokens, client secrets or JWTs are blanked wherever they appear.
- **No LLM calls.** The server never talks to a model. It only returns data.
- **Caps everywhere.** Date range, page size, messages per collect, bytes per attachment, characters per body and per reply. All adjustable, all with defaults.

## Tools

| Tool                  | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `get_mailbox_profile` | Connection test. Email address, message and thread counts, granted scopes, `read_only: true`.                                                                                                                                                                                                                                                                                                                                                                                                   |
| `search_mail`         | Find messages. Metadata and links only, never bodies. Paged with `page_size` and `page_token`.                                                                                                                                                                                                                                                                                                                                                                                                  |
| `get_email`           | One message as a Document: headers, clean body, attachment list, link. `include_thread: true` adds the whole conversation as `thread_text`. `attachments: "text"` extracts each attachment inline.                                                                                                                                                                                                                                                                                              |
| `get_attachment_text` | One attachment as text, by `message_id` plus `filename`. PDF, DOCX, TXT, MD, CSV, HTML. A file it cannot read comes back with a `skipped_reason`, not an error.                                                                                                                                                                                                                                                                                                                                 |
| `get_attachment_file` | The original bytes of one attachment, base64 with its mime type, for apps that want the file as sent. Over `MAX_ATTACHMENT_BYTES` is refused.                                                                                                                                                                                                                                                                                                                                                   |
| `collect_mail`        | Everything matching the filters as Documents in one call. Same filters as `search_mail`, plus `max_messages` (default 50, cap 200), `order` (`newest_first` or `oldest_first`), `after_message_id` (continue after a previous batch), `include_thread`, `attachments` (`text` by default), `max_total_chars`. Replies with `documents`, `skipped` (what was left out and why), `stats`, and `next_after_message_id` (pass it back as `after_message_id` for the next batch; `null` at the end). |

### Filters

`search_mail` and `collect_mail` take the same filter object. Every field is optional, but at least one of `subject`, `from`, `to`, `keywords`, `any_keywords`, `after`, `before`, `label` or `raw_query` must be set.

| Field              | Meaning                                                                                                |
| ------------------ | ------------------------------------------------------------------------------------------------------ |
| `subject`          | Words that must appear in the subject                                                                  |
| `from`, `to`       | An address, a domain, or a name fragment                                                               |
| `keywords`         | Words that must all appear anywhere in the message                                                     |
| `any_keywords`     | Words where at least one must appear                                                                   |
| `after`, `before`  | `YYYY-MM-DD`. `after` is inclusive, `before` exclusive. Range capped at `MAX_RANGE_DAYS` (default 365) |
| `has_attachment`   | `true` or `false`                                                                                      |
| `attachment_types` | Any of `pdf`, `docx`, `txt`, `md`, `csv`, `html`                                                       |
| `label`            | A Gmail label name                                                                                     |
| `raw_query`        | Gmail search syntax appended as is, for anything the fields do not cover                               |

Spam and trash are always excluded. The reply includes `query_used`, the exact Gmail query that ran, so you can see what the filters became. The resource `mail://search-syntax` documents all of this with worked examples and is generated from the same code, so it never drifts.

### The Document shape

Every piece of mail content comes back in this one shape, whichever tool produced it and whichever provider is behind it:

```json
{
  "id": "gmail:18f3a9c0ffee0001",
  "source": "gmail",
  "kind": "email",
  "reference": {
    "message_id": "18f3a9c0ffee0001",
    "thread_id": "18f3a9c0ffee0100",
    "link": "https://mail.google.com/mail/u/0/#all/18f3a9c0ffee0001"
  },
  "headers": {
    "date": "2026-10-14T05:30:00.000Z",
    "from": "Alice Example <alice@example.com>",
    "to": ["me@example.com"],
    "cc": [],
    "subject": "Weekly report"
  },
  "text": "Hello,\n\nHere is the report for the week...",
  "attachments": [
    {
      "attachment_id": "…",
      "filename": "report.pdf",
      "mime": "application/pdf",
      "size": 183221,
      "text": "Week 42 summary...",
      "truncated": false,
      "skipped_reason": null
    }
  ],
  "truncated": false
}
```

`text` is the cleaned body: HTML converted, the quoted history below "On Monday, X wrote:" removed, the signature removed, whitespace normalised. `truncated` is true when a cap cut the body. An attachment that could not be read has `text: null` and a `skipped_reason` of `ATTACHMENT_UNSUPPORTED`, `PARSE_FAILED` or `NO_TEXT_LAYER`.

## Three worked examples

These are the kind of jobs mailsift exists for. Each shows the brief a person would give, the filters the model builds from it, and the call that gets the documents.

### Applications against a job description

Brief: "All the CVs that came in for the Node developer role since September, so I can rank them against the job description."

Filters the model builds:

```json
{ "subject": "Node developer", "after": "2026-09-01", "attachment_types": ["pdf", "docx"] }
```

Call:

```json
{
  "subject": "Node developer",
  "after": "2026-09-01",
  "attachment_types": ["pdf", "docx"],
  "attachments": "text",
  "max_messages": 100
}
```

Each document has the cover email as `text` and the CV's full text in `attachments[0].text`. Your app or the model then compares each one to the job description. Nothing about ranking lives in mailsift; it only delivers the text.

### High priority complaints from last week

Brief: "Customer complaints from the last seven days that sound urgent."

Filters:

```json
{
  "any_keywords": ["complaint", "urgent", "unacceptable", "refund"],
  "after": "2026-10-27",
  "before": "2026-11-03",
  "label": "Support"
}
```

Call `collect_mail` with those filters and `include_thread: true`, so each document also carries `thread_text`, the whole conversation oldest first. The model reads the thread, not just the latest message, and decides what is actually urgent. `skipped` tells you about any attachment it could not open, and `stats.messages_found` versus `stats.messages_returned` tells you whether the cap cut anything.

### Invoices from one supplier this quarter

Brief: "Every invoice from supplier@example.com between July and September, oldest first."

Call:

```json
{
  "from": "supplier@example.com",
  "any_keywords": ["invoice", "statement"],
  "after": "2026-07-01",
  "before": "2026-10-01",
  "attachment_types": ["pdf"],
  "order": "oldest_first",
  "attachments": "text"
}
```

Reply shape:

```json
{
  "query_used": "from:(supplier@example.com) {invoice statement} after:2026/07/01 before:2026/10/01 filename:pdf -in:spam -in:trash",
  "documents": [
    {
      "headers": { "subject": "Invoice 2026-0712" },
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
  },
  "next_after_message_id": null
}
```

`oldest_first` matters for a backlog: without it you get the newest 50 and the oldest invoice never arrives.

To work through a long backlog in batches, add `max_messages: 20` and loop: each reply's `next_after_message_id` goes back in as `after_message_id`, with the same filters and order, until it comes back `null`. The bookmark is a message id, not an offset, so a mail deleted between two batches does not shift the rest. An unknown bookmark (the mail no longer matches) is a `NOT_FOUND` error.

## Resources

Things a client can open without calling a tool. In Claude Desktop they show up in the attachment picker; in Inspector under Resources.

| URI                           | Content                                                                                                          |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `mail://profile`              | Same JSON as `get_mailbox_profile`.                                                                              |
| `mail://search-syntax`        | Markdown: every filter field, the Gmail syntax it becomes, the rules, six worked examples. Needs no credentials. |
| `mail://message/{message_id}` | One email as markdown: subject, headers, clean body, attachment list. Attachments listed, not extracted.         |
| `mail://thread/{thread_id}`   | The whole conversation as one markdown page, oldest first, one section per message.                              |

A resource read that fails returns a JSON-RPC error whose `data` holds the same `{ code, message, hint }` body the tools use.

## Prompts

Instruction templates a client fetches by name with the blanks filled in. The server returns text only; it never calls a model. In Claude Desktop and Claude Code they appear as slash commands. A backend fetches them with `prompts/get` so the workflow is defined once, next to the tools, and quotes the server's real limits.

| Prompt              | Arguments                                                     | What it tells the model                                                                                                                                                                                    |
| ------------------- | ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `build_mail_query`  | `request`, `today` (`YYYY-MM-DD`), `default_window_days`      | Turn one sentence into `search_mail` filters. Prefer facts, never invent a sender, resolve dates from `today`, say what is missing if there is nothing to filter on.                                       |
| `collect_for_brief` | `brief`, `hints` (optional free text: subject, sender, dates) | Search, look at the count and subjects, refine at most twice (narrow when over the collect cap, widen when under 3), `collect_mail` once, stop and report. Still unsure after two tries: ask one question. |
| `explain_results`   | none                                                          | Describe the last `collect_mail` reply in plain words: how many, what was skipped and why, the query used.                                                                                                 |

## Errors

Every failure is a structured object, never a raw stack. From a tool it arrives as a result with `isError: true`; from a resource or prompt as a JSON-RPC error with the same body in `data`.

```json
{
  "code": "RANGE_TOO_WIDE",
  "message": "Date range is 400 days, the limit is 365.",
  "hint": "Narrow the date range."
}
```

| Code                     | When                                                              | What to do                                           |
| ------------------------ | ----------------------------------------------------------------- | ---------------------------------------------------- |
| `AUTH_MISSING_TOKEN`     | No `MAIL_TOKEN` in env (stdio) or no `X-Mail-Token` header (HTTP) | Connect a mailbox                                    |
| `AUTH_TOKEN_INVALID`     | Google rejected the token                                         | Refresh it                                           |
| `AUTH_SCOPE_TOO_BROAD`   | The token carries more than `gmail.readonly`                      | Reconnect with read-only only                        |
| `AUTH_SERVER_KEY`        | HTTP only: missing or wrong `Authorization` header                | Send a valid server key                              |
| `QUERY_EMPTY`            | No filter set                                                     | Give at least one                                    |
| `RANGE_TOO_WIDE`         | `after` to `before` is wider than `MAX_RANGE_DAYS`                | Narrow it                                            |
| `NOT_FOUND`              | Unknown message, thread or attachment id                          | Search again for a fresh id                          |
| `ATTACHMENT_UNSUPPORTED` | Type or size not handled                                          | Skipped; the rest of the reply is fine               |
| `RATE_LIMITED`           | Gmail asked us to slow down after retries                         | Wait a minute, use a smaller `page_size`             |
| `PROVIDER_ERROR`         | Anything else from Gmail or inside the server                     | Check the logs; the message never contains the token |

## Configuration

All through environment variables. Copy `.env.example` to `.env` and run with `npm run dev:env -- [--http]` to load it.

| Variable                                                        | Default                      | Notes                                                                                            |
| --------------------------------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------ |
| `MAIL_TOKEN`                                                    | none                         | stdio only. A read-only Gmail access token.                                                      |
| `GMAIL_REFRESH_TOKEN`, `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET` | none                         | stdio only. Alternative to `MAIL_TOKEN`; the server mints and refreshes access tokens in memory. |
| `MAIL_PROVIDER`                                                 | `gmail`                      | stdio only. The only value for now.                                                              |
| `MCP_SERVER_KEYS`                                               | none                         | HTTP only, required. Comma separated. `openssl rand -hex 32` makes one.                          |
| `PORT`, `HOST`                                                  | `3000`, `0.0.0.0`            | HTTP only. `HOST=127.0.0.1` keeps a laptop run off the network.                                  |
| `LOG_LEVEL`                                                     | `info`                       | `debug`, `info`, `warn`, `error`. JSON lines on stderr.                                          |
| `MAX_RANGE_DAYS`                                                | `365`                        | Widest `after` to `before` span.                                                                 |
| `MAX_PAGE_SIZE`                                                 | `100`                        | `search_mail` page.                                                                              |
| `MAX_COLLECT_MESSAGES`                                          | `200`                        | Hard cap on `collect_mail`'s `max_messages`.                                                     |
| `MAX_SEARCH_IDS`                                                | `2000`                       | How far `oldest_first` walks before giving up.                                                   |
| `MAX_ATTACHMENT_BYTES`                                          | `10485760`                   | Larger attachments are skipped.                                                                  |
| `MAX_MESSAGE_CHARS`, `MAX_ATTACHMENT_CHARS`, `MAX_TOTAL_CHARS`  | `50000`, `100000`, `2000000` | Per body, per attachment, per `collect_mail` reply.                                              |
| `FETCH_CONCURRENCY`                                             | `5`                          | Parallel Gmail fetches.                                                                          |
| `GMAIL_TIMEOUT_MS`, `SCOPE_CACHE_TTL_MS`                        | `20000`, `600000`            | Request timeout; how long a token's scope check is remembered.                                   |

The five mailbox variables are read only over stdio. Over HTTP the token comes from the header on every request, and those variables are ignored even if set.

## Checking a build by hand

Automated tests run offline against recorded Gmail responses. This is the walk-through against a real mailbox, the one we run before calling a release done. Use Inspector with a read-only token as in the quickstart.

1. `get_mailbox_profile`: your address, counts, `scopes` containing only `gmail.readonly`, `read_only: true`.
2. `search_mail` with a subject word: items with `message_id`, `thread_id`, `link`, no bodies. Open a link; it lands on that message.
3. `get_email` with one `message_id` from a reply in a thread: `text` has no "On ... wrote:" block and no signature. Add `include_thread: true`: `thread_text` has every message, oldest first.
4. `get_attachment_text` with a message that has a PDF, by `filename`: the PDF's text. Try a `.zip` or an image: `skipped_reason`, no error.
5. `get_attachment_file` with the same PDF: a base64 block whose decoded size equals `size`.
6. `collect_mail` with a filter that matches more than `max_messages`: `stats.truncated` true, `messages_found` larger than `messages_returned`. Add `order: "oldest_first"`: the first document is the oldest.
7. Resources: read `mail://search-syntax` with no token in the env and it still works. Read `mail://message/<id>` and `mail://thread/<id>`: markdown with the subject as the heading.
8. Prompts: `collect_for_brief` with a brief: one user message containing the brief and the server's collect cap.
9. A token with a write scope: every tool answers `AUTH_SCOPE_TOO_BROAD` before touching mail.
10. HTTP: start with `--http`, `curl /healthz` without a key works, `POST /mcp` without a key is 401, with the two headers `tools/list` works. See [examples/curl-http.md](examples/curl-http.md).

## Development

Node 22 or newer for development, 20 or newer at runtime.

```
npm install
npm run check     # lint + typecheck + test, all offline
npm run dev       # run from source over stdio
npm run build     # tsup -> dist/index.js
```

Design notes, decisions and the phase tracker are in [docs/](docs/). Never write to stdout in the server: it is the protocol channel over stdio.

## Licence

MIT
