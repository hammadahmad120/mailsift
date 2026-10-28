# Decisions log

Short record of choices that are not obvious from the code. Newest at the bottom. Add an entry whenever a choice deviates from the brief, picks between options the brief left open, or would surprise a new contributor.

Format: date, decision, why, consequence.

---

**2026-10-22 — Package and repo name is `mailsift`, not `mail-to-docs-mcp`.**
Why: the repo was created as `mailsift` before the brief was pasted in. The brief's name was a working title.
Consequence: the CLI binary is `mailsift`, the npm package is `mailsift`, README and examples use `npx mailsift`.

**2026-10-22 — TypeScript pinned to 5.x, not 7.x.**
Why: TypeScript 7 (the native Go compiler) is on npm as `latest`, but `typescript-eslint` only supports `<6.1`.
Consequence: `"typescript": "^5.9.3"`. Revisit when typescript-eslint supports 7.

**2026-10-22 — zod 4.**
Why: `@modelcontextprotocol/sdk` 1.32 accepts `^3.25 || ^4.0`. Starting on 4 avoids a migration later.
Consequence: use `zod` v4 APIs only. Do not import from `zod/v3`.

**2026-10-22 — `unpdf` for PDF text extraction, not `pdf-parse`.**
Why: the brief allowed either. `unpdf` is ESM-first, has no native deps, and is maintained. `pdf-parse` is CommonJS and stale.
Consequence: `src/parse/attachments/pdf.ts` will use `unpdf`'s `extractText`.

**2026-10-22 — `tsup` for build, ESM only, Node 20 target.**
Why: the brief allowed `tsup` or plain `tsc`. `tsup` gives a single-file bin with a shebang banner and `.d.ts` output in one step.
Consequence: `dist/index.js` is the published entry. `package.json` is `"type": "module"`.

**2026-10-22 — Local dev on Node 24, `engines` says `>=20`.**
Why: vitest 5 and tsup 9 require Node 22.12+ for development. The built output targets Node 20 so users on 20 can still run the server.
Consequence: `.nvmrc` says 24. Contributors need Node 22+. Runtime users need Node 20+.

**2026-10-22 — `CLAUDE.md` and `.claude/` are git-ignored; durable context lives in `docs/`.**
Why: the owner's `.gitignore` excludes AI assistant files. The design brief, status, and decisions are project knowledge that must travel with the repo.
Consequence: `CLAUDE.md` is a thin local pointer plus working rules. Anything a future contributor or session needs is in `docs/`. If the repo is cloned elsewhere, re-create `CLAUDE.md` from `docs/claude-context.md`.

**2026-10-23 — Refresh-token minting lives in `credentials.ts` and is the one non-GET outbound call.**
Why: the brief allows the stdio refresh-token convenience (section 6). Minting is a `POST` to `oauth2.googleapis.com/token`, which is Google's OAuth endpoint, not the Gmail API. Routing it through the GET-only Gmail client would break the allow-list rule for no safety gain: the call cannot touch mail.
Consequence: `src/providers/gmail/client.ts` stays strictly GET-only against `gmail.googleapis.com`. The token endpoint call is isolated in `src/auth/credentials.ts`, uses injected `fetch`, and is covered by tests. Minted tokens are cached in memory only, refreshed 60 seconds before expiry.

**2026-10-27 — Tool handlers receive their dependencies through a `ServerDeps` object; tool replies are two text blocks.**
Why: the brief says both transports build the same `McpServer` and that tests run offline. `createServer(deps)` takes `{ config, resolveCredentials, createProvider }` so a test can connect a real MCP `Client` over the SDK's in-memory transport and swap in a fake provider, while `createDefaultDeps()` is the only production wiring. The brief's "one JSON text block plus a short human summary line" is implemented as exactly two `text` content blocks, JSON first, summary second, built by `toolResult()` in `src/tools/result.ts`.
Consequence: every tool is registered as `registerX(server, deps)` and never imports a provider or reads `process.env` directly. Apps parse `content[0].text` as JSON; `content[1].text` is for humans and models. `src/tools/` holds shared helpers (`result.ts`, later `with-mailbox.ts`) next to the one-file-per-tool modules.

**2026-10-27 — The locked Gmail client, error model and provider interface were built in phase 1, ahead of the brief's phase 2 listing.**
Why: the brief's phase 1 is "McpServer with `get_mailbox_profile`", but that tool needs a real call to Gmail's `profile` endpoint. Making the call through anything other than the locked client would have meant a throwaway `fetch` path that bypasses the read-only allow-list, even briefly. So the client (GET only, allow-list of `profile` alone), the `{ code, message, hint }` error model, and the five-method provider interface were built first and the tool sat on top of them.
Consequence: phase 2 extends what exists rather than introducing it: task 2.3 widens the allow-list and adds retries, task 2.2 adds the scope check in front of the client. No code path ever reached Gmail outside the locked client, including during phase 1 testing.

**2026-10-27 — `CLAUDE.md`, `.claude/` and `docs/` are tracked in git during development.**
Why: supersedes the 2026-10-22 entry above. The owner wants the Claude context, the sync-docs skill and the design docs pushed with the code so other machines and sessions see the same state. Until now `docs/` was ignored too, so the brief, status, tasks and this log existed only on one machine.
Consequence: the three ignore lines were removed from `.gitignore`. The owner intends to strip the AI-specific files before publishing to npm or making the repo public; `docs/` may stay. `docs/claude-context.md` remains the restore copy of `CLAUDE.md` for that case. Never commit `.claude/settings.local.json` or anything holding a token; `.env` stays ignored.

**2026-10-28 — Query builder: values are sanitized rather than escaped, subject/from/to are word groups, attachment flags alone are an empty query, `after` alone is measured against today.**
Why: Gmail search has no documented escape character, so a value containing `"`, `(`, `)`, `{` or `}` cannot be made safe by escaping. `buildQuery` strips those five characters, collapses whitespace, and quotes any term that still contains a space. Nothing a model types can close a group or start a new operator. `subject`, `from` and `to` become `field:(words)` (every word must appear in that field) to match the brief's own example `subject:(Node)` and to be forgiving of word order; `keywords` entries are single terms AND-joined; `any_keywords` is a `{a b}` group; `attachment_types` is `filename:pdf` or `(filename:pdf OR filename:docx)`; `has_attachment: false` emits `-has:attachment`. `QUERY_EMPTY` is thrown unless at least one of subject, from, to, keywords, any_keywords, after, before, label or raw_query is set, because `has:attachment` on its own would scan the whole mailbox. `RANGE_TOO_WIDE` is checked for `after`..`before`, and for `after`..now when `before` is absent (`now` is injectable for tests); `before` alone is unbounded into the past and is treated like no date, the same as a query with no dates at all. Dates must be `YYYY-MM-DD`; a malformed date throws a plain `TypeError` because the tool's zod schema (task 2.6) makes it unreachable from a client and the error codes in brief section 10 are fixed.
Consequence: `buildQuery(filters, { maxRangeDays, now? })` takes the limit as an argument, so it never reads config. Labels with spaces become hyphenated (`label:Job-Applications`), Gmail's own convention. The `mail://search-syntax` resource in phase 6 must describe these mappings; `test/query-builder.test.ts` is its source.

**2026-10-28 — Scope check is a factory with an injected cache; too-broad verdicts are cached, invalid-token verdicts are not; cache life is capped by the token's own expiry.**
Why: the brief (section 7, layer 3) asks for `assertReadOnlyScope(token)` with a 10-minute verdict cache keyed by a token hash. A module-level cache would leak between tests and between servers in one process, so `createScopeCheck({ ttlMs, fetch?, now? })` returns the `assertReadOnlyScope` function with its own `Map`, mirroring `createCredentialResolver`. A token's scopes never change, so an `AUTH_SCOPE_TOO_BROAD` verdict is cached too and a rejected caller cannot hammer Google by retrying. `AUTH_TOKEN_INVALID` and `PROVIDER_ERROR` are not cached: a transient Google error must not lock a good token out for ten minutes. Google's tokeninfo reply includes `expires_in`, so an entry lives for `min(ttlMs, expires_in)`; a verdict is never trusted longer than the token itself. The cache evicts its oldest entry past 1000 keys so HTTP mode with many tokens stays bounded. The verdict also carries the `email` Google reports; the profile tool may use it later.
Consequence: `src/auth/scope-check.ts` is the second and last module that talks to `oauth2.googleapis.com` outside the Gmail client (the first is refresh-token minting). The token travels in the `access_token` query parameter as the brief specifies; error messages name offending scopes but never the token, and `redactSecrets` already covers the `access_token=` shape. Wiring the check in front of every tool, and passing its `scopes` to `GmailProvider`, is task 2.8.

**2026-10-28 — The Gmail allow-list refuses Gmail's write verbs by name, and retries live in the client with an injectable sleep.**
Why: the full read allow-list is `profile`, `messages`, `messages/{id}`, `threads/{id}` and `messages/{id}/attachments/{id}`, matched by exact regexes. Gmail puts its write verbs where an id would be (`messages/send`, `messages/import`, `messages/batchDelete`), so `messages/send` matched the id pattern. Those endpoints only answer to POST, which this client cannot send, but the allow-list should read as what it is: ids only. `isAllowedPath` therefore also refuses any path segment in `RESERVED_SEGMENTS` (`send`, `import`, `insert`, `batchDelete`, `batchModify`, `modify`, `trash`, `untrash`, `delete`, and `attachments` outside its one legal position). Retries follow brief section 8.4: 429 and 5xx are retried, three tries in total, backoff 500 ms doubling, `Retry-After` in seconds or as an HTTP date wins when present, every wait capped at 30 s. 401, 403, 404 and network errors are not retried. `sleep`, `maxAttempts` and `baseDelayMs` are constructor options so tests run instantly and record the waits.
Consequence: after the last try a 429 is `RATE_LIMITED` and a 5xx is `PROVIDER_ERROR`, both messages ending "after 3 tries". The phase 4 concurrency limiter sits on top of this and adds nothing of its own for retries.

**2026-10-28 — MIME helpers: body is the first non-empty text part, inline parts are judged by disposition then Content-ID, and only parts with an attachment id are listed.**
Why: Gmail's `format=full` payload is a tree. `findBodyPart` walks it depth-first and returns the first non-empty `text/plain` part, else the first non-empty `text/html` part; parts with a filename are never body, so a `.txt` attachment cannot masquerade as the message. Empty parts are skipped because some mailers send a blank plain alternative next to a real HTML one. A part counts as inline, and is left out of `listAttachments`, when its `Content-Disposition` starts with `inline`, or when it has no disposition but carries a `Content-ID`; a part explicitly marked `attachment` is kept even if it also has a `Content-ID`. Parts with a filename but no `attachmentId` (Gmail inlines very small attachments as `body.data`) are not listed; `getAttachment` needs an id to fetch, and such parts are rare and tiny. Body data is decoded as UTF-8 since Gmail serves text parts transcoded. The `Date` header is parsed to ISO 8601, falling back to `internalDate`, then `''`. Address headers are split on commas outside quotes and angle brackets, so `"Doe, Jane" <jane@example.com>` stays one entry.
Consequence: the three message fixtures in `test/fixtures/gmail/` are hand-built in Gmail's exact shape with example.com addresses, generated by a script so the base64url bodies are correct; nothing in them came from a real mailbox. If inline-by-data attachments ever matter, add a synthetic `part:<partId>` id scheme and handle it in `getAttachment`.

**2026-10-28 — Provider search fetches each listed message with `format=full` and sequentially; malformed ids are `NOT_FOUND`.**
Why: Gmail's list endpoint returns ids only, so `search` makes one call per result for headers, snippet and attachment metadata. The brief (section 16) lists `messages/{id}?format=full` as the endpoint, and `format=metadata` is not confirmed to include the `attachmentId` and `size` on attachment parts, so `full` is used for search items too. Bodies arrive but never leave `search`; `toSearchItem` copies only metadata fields. The per-item fetches run one after another for now: the brief's concurrency limiter is task 4.1 and will be wired into `search` then rather than duplicated here. A message or thread id that is not URL-safe (`[A-Za-z0-9_=-]+`) is refused by the provider with `NOT_FOUND` and a hint to use ids from `search_mail`, instead of letting the client's allow-list reject it as a confusing `PROVIDER_ERROR`. Thread messages are ordered by `internalDate`, falling back to the `Date` header.
Consequence: `search` on a page of 25 costs 26 Gmail calls and up to a few seconds until 4.1 lands. `GmailProvider` takes `maxRangeDays` (from config) and an injectable `now` for the query builder. `list.json` and `thread.json` fixtures are derived from the three message fixtures by a script; the thread is stored out of date order so the sort is proven.

**2026-10-28 — `search_mail` clamps `page_size` to `MAX_PAGE_SIZE` instead of rejecting it; zod validates shape, the provider validates meaning.**
Why: a model that asks for 500 results should get the server's maximum, not a schema error it has to parse and retry. The zod schema therefore checks only shape: non-empty strings, `YYYY-MM-DD` dates, the six attachment types, a positive integer page size. Anything about meaning (no filter at all, a date span too wide) is left to `buildQuery` inside the provider so the model gets the structured `QUERY_EMPTY` or `RANGE_TOO_WIDE` body with its hint. Shape failures surface as the SDK's own validation error before credentials are resolved, so a bad argument never costs a Gmail call. Every field carries a description because the description is the only documentation the model sees.
Consequence: `toSearchCall(args, maxPageSize)` is the exported pure function that splits tool arguments into `SearchFilters` and `SearchPage`, dropping undefined keys. Later tools follow the same split: zod for shape, provider or parse layer for meaning.

**2026-10-28 — `get_email` builds the Document through a pure `toDocument` in `src/parse/document.ts`; phase 2 ships raw bodies and a raw thread separator there.**
Why: the brief's section 9 shape must stay identical across providers, so it is assembled in one pure function from `RawMessage` values, never inside a provider or a tool. In phase 2 the body is the provider's text or HTML untouched and `thread_text` is built by `rawThreadText` with the brief's `--- From <from> on <date> ---` separator. Phase 3 replaces exactly two call sites, `rawBodyText` with the cleaning pipeline and `rawThreadText` with `flattenThread` from task 3.4, and nothing else moves. `truncated` is true when either the body or the thread text was cut at `max_chars`; both share the one cap so a reply never exceeds roughly twice `MAX_MESSAGE_CHARS`. The brief's `attachments` mode and `max_attachment_chars` are left out of the tool until phase 3 gives them meaning; attachments are listed with `text: null`.
Consequence: the Document `id` is `<provider>:<message_id>`, taken from `provider.name` so a future IMAP provider needs no tool change. `include_thread` costs one extra provider call (`getThread`) and nothing otherwise.
