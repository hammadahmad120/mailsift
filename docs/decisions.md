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
