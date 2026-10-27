---
name: sync-docs
description: Walk the docs-sync checklist so docs/status.md, docs/decisions.md, README.md, .env.example and CLAUDE.md match the current code. Run at the end of any implementation work or when asked to "sync docs", "update status", or "record a decision".
---

# Sync docs with the code

Goal: after this runs, every doc describes the state the code is actually in. Do not write aspirational text.

## Steps

1. Establish what changed. Run `git status --short` and `git diff --stat` (and `git log --oneline -5` if the work was already committed). Read the changed files enough to know what they do now.

2. Run `npm run check`. If it is red, say so in `docs/status.md` under "Known issues" with the failing command and the first error line. Do not mark anything done while it is red.

3. Tick the verified task(s) in `docs/tasks.md`. Never tick a task whose Verify step the user has not confirmed. If the task's scope changed, edit its Build or Verify lines to match reality.

4. Update `docs/status.md`:
   - Phase table: status column and date for any phase that moved. Only mark a phase **Done** if `npm run check` is green and the manual check in the table's "Done when" column was actually performed.
   - "Current state of the code": rewrite to match. Mention which `src/` files exist and do real work, which are placeholders.
   - "Known issues": add new ones, remove fixed ones.
   - "Next step": one short paragraph naming the next concrete thing to build.

5. Update `docs/decisions.md` if any of these happened: deviated from `docs/design-brief.md`, chose between options the brief left open, picked a library or pattern a new contributor would question. One entry per decision: date, decision, why, consequence.

6. If the brief itself had to change, confirm the `decisions.md` entry exists first, then make the smallest edit to `docs/design-brief.md` with a "(changed YYYY-MM-DD, see decisions.md)" note.

7. Check `README.md` against user-facing changes: tools, env vars, headers, commands, examples. Update what is stale.

8. Check `.env.example` against `src/config.ts` (once it exists). Every env var the code reads must be listed with its default.

9. Confirm `CLAUDE.md` and the body of `docs/claude-context.md` are identical: `diff <(sed -n '/^# mailsift$/,$p' docs/claude-context.md) CLAUDE.md`. If they differ, decide which is right and copy it to the other.

10. Run `npm run lint` once more because prettier checks markdown too.

11. Report in three lines: what moved in status, what decisions were added, what is still inconsistent (if anything).
