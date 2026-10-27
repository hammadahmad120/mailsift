# Claude context (tracked copy)

This file is a copy of `CLAUDE.md` at the repo root. Both are tracked for now (decision 2026-10-27); before publishing, `CLAUDE.md`, `.claude/` and `docs/` may be dropped from the repo again, and this copy is what restores `CLAUDE.md`:

```
cp docs/claude-context.md CLAUDE.md
```

Keep the two in sync. When you change one, change the other.

---

# mailsift

Read-only MCP server that turns mailbox content into clean, model-ready documents. Gmail first, provider interface for IMAP and Microsoft 365 later. No writes, no LLM calls, no stored credentials. Package and binary name: `mailsift`.

## Read these first, in this order

1. `docs/status.md` — which phase we are in and what the next step is.
2. `docs/tasks.md` — the task list. Work on exactly one unticked task at a time. Each task ends with its Verify step done by the user, then the box is ticked.
3. `docs/design-brief.md` — the full agreed design. It is the spec. Sections 3 (non-goals), 7 (read-only enforcement), 9 (document shape), 10 (errors), 12 (phases) are binding.
4. `docs/decisions.md` — choices already made. Do not re-open them without saying so.

## Hard rules

- Work one task at a time from `docs/tasks.md`. After each task, explain what was built and how, then stop and let the user run the Verify step. Do not start the next task until asked.
- Build phase by phase as listed in the brief, section 12. Never skip or merge phases. Finish the current phase (tests green plus the manual check) before starting the next.
- Nothing from the brief's section 3 "Non-goals". If something seems to need it, stop and ask.
- No write code paths against any mail provider, ever. The Gmail client allows `GET` only against an explicit path allow-list.
- Tokens never appear in tool arguments, schemas, logs, error messages, test fixtures, or docs.
- Names stay generic: mail, message, document, attachment. Never resume, candidate, job, complaint, invoice in code. Those words belong in README examples only.
- No `googleapis` package. Direct `fetch` through the locked client.
- Keep the Document shape (brief section 9) stable across providers.

## Stack and commands

TypeScript 5 strict, ESM, Node 20+ at runtime, Node 22+ for development. `@modelcontextprotocol/sdk`, zod 4, Express 5, `html-to-text`, `unpdf`, `mammoth`. Tests with vitest, build with tsup, lint with eslint + prettier.

```
npm run check       # lint + typecheck + test, must be green before any phase is called done
npm run dev         # tsx src/index.ts
npm run build       # tsup -> dist/index.js
npm run lint:fix    # eslint --fix + prettier --write
```

Definition of done for any piece of work: `npm run check` green, the phase's manual check done, and the docs-sync rule below applied.

## Docs-sync rule (applies to every change)

Code and docs move together in the same piece of work. Before you report a task as complete:

1. **`docs/tasks.md`** — tick the task just verified. If the task's scope changed while building, edit its Build or Verify lines to say what was actually done.
2. **`docs/status.md`** — update the phase table, "Current state of the code", "Known issues", and "Next step" to match what is now true. If you finished a phase, mark it done with the date.
3. **`docs/decisions.md`** — add an entry for any choice that deviates from the brief, picks between options the brief left open, or would surprise a new contributor. Include why and the consequence.
4. **`docs/design-brief.md`** — do not edit casually. If the implementation has to differ from the brief, record the change in `decisions.md` first and then make the smallest edit to the brief that keeps it accurate, with a note "(changed 2026-xx-xx, see decisions.md)".
5. **`README.md`** — update when a user-facing thing changes: a tool, an env var, a header, a command, an example.
6. **`.env.example`** — update when an env var is added, removed, or its default changes.
7. **`CLAUDE.md` and `docs/claude-context.md`** — keep identical. Update both when the rules, commands, or stack change.

Run `/sync-docs` to walk through this checklist at the end of a session. A task is not done if the docs describe a state the code is not in.

## Working style

- Tests are fixture-based and offline. No network in tests. Recorded Gmail JSON lives in `test/fixtures/`.
- Pure functions for all parsing and cleaning (brief section 11), each with a unit test.
- One file per tool, resource, and prompt, as in the brief's section 14 layout.
- Errors are structured `{ code, message, hint }` per brief section 10. Never let a provider error escape as a raw throw from a tool handler.
- Prefer small, reviewable steps. Say what you changed and what you verified.
