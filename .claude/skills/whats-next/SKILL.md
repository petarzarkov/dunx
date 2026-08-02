---
name: whats-next
description: Write or refresh HANDOFF.md - a compact resume point holding completed objectives, live file paths, approaches already tried and rejected, and the exact next steps, placed against the roadmap in docs/ROADMAP.md. Use before /compact or /clear, at the end of a task block, when the context window crosses ~50%, or when asked "what's next", "where were we", "hand this off", or "resume".
---

# /whats-next

Produce `HANDOFF.md` at the repo root: everything needed to resume this work in a
**fresh** session and nothing else. It will be read cold, by a session with no
memory of this one. Optimise for that reader, not for a record of what happened.

## Gather

One batch, then stop:

```bash
git status --short && git log --oneline -8
```

Read the **Roadmap** and **Spikes to resolve** sections of
[docs/ARCHITECTURE.md](../../../docs/ARCHITECTURE.md). That doc is the source of truth for
what "next" means - the current phase's exit criteria _are_ the next steps.
Never invent a roadmap position from the conversation.

Add what only this session knows: what you actually changed, and what you tried
that did not work.

If the session is thin on state - resumed, compacted, or you were handed a
HANDOFF.md rather than doing the work - do not read packages into this thread to
fill the gaps. Delegate one `Explore` subagent per unresolved exit criterion and
ask each for a one-line verdict plus `file:line`. The exploration stays in their
context window; only the verdict comes back.

## Write

Overwrite `HANDOFF.md` with this shape. Omit a section that has no content -
never write "N/A" or "none".

```markdown
# HANDOFF - <YYYY-MM-DD>

**Roadmap:** Phase <n> - <name> · <met>/<total> exit criteria met
**Branch:** <branch> @ <short sha> · <clean | n files dirty>

## Done

- <objective> - <where it landed>

## Live files

- [path](path) - <what is half-finished in it>

## Rejected - do not retry

- <approach> - <what broke>

## Next

1. <exact command, or exact edit to an exact path>

## Open questions

- <question> - <what decides it>
```

## Rules

- **Hard cap ~60 lines.** This file is loaded at the start of the next session.
  Every line is a permanent tax on it.
- **Next steps are commands and edits, not intentions.** "Add `token()` and
  `inject()` to `packages/core/src/di/`, resolving through a module-level
  `currentInjector` set around each `new Klass()`" - not "continue DI work".
- **Rejected is the highest-value section.** It is the only content a fresh
  session cannot re-derive from the tree. Record the approach, the symptom, and
  the path it lives or lived in. Rejections already written down in
  docs/architecture/ belong there, not here - link, don't copy.
- Paths as clickable relative markdown links.
- If an exit criterion has become true, say so. If docs/ARCHITECTURE.md is stale,
  fix that doc - do not record the drift in HANDOFF.md.
- No conversation summary, no restatement of the plan, no preamble.

## After writing

State the path and the roadmap position in one line, then name the next move:

- same subtask, context heavy → `/compact`, and say explicitly what to preserve
- switching subtask → `/clear`, then `continue from HANDOFF.md`

`HANDOFF.md` is gitignored. It is session state, not a repo artifact - rewrite it
freely.
