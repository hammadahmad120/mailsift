# Build status

Single source of truth for where the project is. Update this file at the end of every piece of work (see the docs-sync rule in `CLAUDE.md`).

Phases are defined in [design-brief.md](design-brief.md) section 12. Do them in order. Never merge or skip.

The phase-by-phase task breakdown with a verify step per task is in [tasks.md](tasks.md). Tick tasks there as they are verified.

| Phase | Scope                                                                                                               | Status                 | Done when                                                             |
| ----- | ------------------------------------------------------------------------------------------------------------------- | ---------------------- | --------------------------------------------------------------------- |
| 0     | Environment setup: TypeScript, eslint, prettier, vitest, tsup, folder layout, Claude context, docs                  | **Done** (2026-10-22)  | `npm run check` green, `node dist/index.js` runs                      |
| 1     | Scaffold: `McpServer` with `get_mailbox_profile` only, stdio transport, env credentials                             | **Done** (2026-10-27)  | MCP Inspector lists one tool and calls it with a real read-only token |
| 2     | Gmail adapter, `search_mail`, `get_email` (bodies only), locked client, scope check, error model, recorded fixtures | In progress (2.1 done) | Tests pass against recorded JSON, manual search works in Inspector    |
| 3     | Text cleaning and attachments, `get_attachment_text`, all of section 11 with fixtures                               | Not started            | Cleaning and parser tests green on HTML, quoted replies, PDF, DOCX    |
| 4     | `collect_mail` with concurrency, retries, caps, `skipped` and `stats`                                               | Not started            | Bundle call returns documents and stats under the caps                |
| 5     | HTTP transport, server keys, header credentials, `/healthz`, redacted logging, no-token-in-logs test, Dockerfile    | Not started            | curl with the two headers works, logging test green, image builds     |
| 6     | Resources, prompts, README with three examples, npm publish setup                                                   | Not started            | Inspector shows resources and prompts, `npm pack` is clean            |
| 7     | Later, only when asked: IMAP, Microsoft 365, stored-account mode, spreadsheets, OCR                                 | Blocked by design      | Explicit request                                                      |

## Current state of the code

- `src/config.ts` is done: `loadConfig(env)` with zod validation, defaults from the brief, secrets kept off the object.
- `src/errors.ts` is done: `MailError`, `toToolError`, `redactSecrets`.
- `src/providers/types.ts` is done: `Document`, `SearchFilters`, `SearchResult`, `MailboxProfile`, `RawMessage`, and the five-method `MailProvider` interface.
- `src/auth/credentials.ts` is done: `createCredentialResolver` reads MAIL_TOKEN or mints from the Gmail refresh trio with an in-memory cache.
- `src/providers/gmail/client.ts` is done: GET-only client with a path allow-list (`profile` only so far), timeout, and HTTP status mapping.
- `src/providers/gmail/provider.ts` is done for `getProfile`; the other four methods throw "not implemented" until phase 2.
- `src/providers/gmail/query-builder.ts` is done: `buildQuery(filters, { maxRangeDays, now? })`, pure, turns `SearchFilters` into a Gmail `q` string. Values are sanitized (quotes and brackets stripped, phrases quoted), `-in:spam -in:trash` is always appended, `QUERY_EMPTY` and `RANGE_TOO_WIDE` are thrown as `MailError`. Not yet wired to the provider (task 2.5).
- `src/server.ts` is done: `createServer(deps)` makes the `McpServer` and registers tools; `createDefaultDeps(env)` is the production wiring (config, env credentials, Gmail through the locked client). Tool handlers get their dependencies through `ServerDeps` so tests inject fakes.
- `src/tools/get-mailbox-profile.ts` is done: the first tool, empty zod input, read-only annotations, handler = resolve credentials -> build provider -> `getProfile` -> `toolResult`, errors via `toToolError`. `src/tools/result.ts` holds `toolResult(data, summary)`, the two-block reply every tool uses.
- `src/transports/stdio.ts` is done: `runStdio(server, streams)` connects the server to `StdioServerTransport`; streams are injectable for tests.
- `src/index.ts` is the real CLI entry: `main(argv, options)` returns an exit code, `--stdio` is the default, `--http` exits 1 with a "phase 5" message, config errors exit 1 with the zod message, logs go to stderr only. The direct-run guard compares `import.meta.url` with the resolved `process.argv[1]`, so importing the module in tests never starts a server.
- `examples/claude-code.md` explains getting a read-only token from OAuth Playground, running under MCP Inspector, and the Claude Code `.mcp.json` snippet with `${MAIL_TOKEN}` expansion.
- Empty so far (`.gitkeep` only): `src/resources/`, `src/prompts/`, `src/parse/attachments/`.
- Tests: 88 passing across `config`, `errors`, `credentials`, `gmail-client`, `gmail-provider`, `query-builder`, `server` (real MCP `Client` over the SDK in-memory transport), `stdio` (real `StdioServerTransport` driven through in-memory streams), plus the toolchain smoke test. All offline. Recorded fixtures live in `test/fixtures/gmail/`.
- Phase 1 is complete: all nine tasks verified, including the manual Inspector check against a real read-only token.
- Not built yet (phase 2+): scope check, MIME helpers, search/get tools, cleaning, attachments, collect, HTTP transport, resources, prompts.

## Known issues

- `npm audit` reports a moderate finding in `sprintf-js` via `argparse`, pulled in by `mammoth`'s CLI. The server never uses mammoth's CLI. The only automated fix downgrades mammoth to a 2014 release, so it is left as is. Re-check when mammoth updates its `argparse` dependency.

## Next step

Task 2.2 in [tasks.md](tasks.md), the scope check: `assertReadOnlyScope(token)` in `src/auth/scope-check.ts`. Calls Google's tokeninfo endpoint, reads `scope`, throws `AUTH_SCOPE_TOO_BROAD` if any scope is outside the allow-list (`gmail.readonly`, `gmail.metadata`, `userinfo.email`, `openid`) and `AUTH_TOKEN_INVALID` if Google rejects the token. Verdicts cached for `SCOPE_CACHE_TTL_MS` keyed by a SHA-256 of the token. Tests with mocked `fetch`. Phase 2 ends at 2.9 with a manual search and get in Inspector.
