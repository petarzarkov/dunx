---
name: docs-pass
description: Revise one documentation file so it states facts instead of performing insight, and get it under the budgets in scripts/no-slop.test.ts. Use when writing a new guide or README, when a reader reports the docs read like AI output, or when `bun test scripts/no-slop.test.ts` fails.
---

# /docs-pass

One file per invocation. The guard is
[scripts/no-slop.test.ts](../../../scripts/no-slop.test.ts); it owns the mode
map and the budgets, and this skill is how a file gets under them.

```bash
bun test scripts/no-slop.test.ts    # names every file, its mode, and what it blew
```

## The rule that does the work

**Cut. Do not rewrite.** Asking for a rewrite produces different prose at the
same length, and the length is the defect. Every pass should shrink the file.
A paragraph that survives three deletions and still says the same thing was
three sentences long.

Delete outright, without replacement:

- Any sentence that tells the reader what the previous sentence meant.
- Any sentence about the design's virtue rather than its behaviour. Move it to
  `docs/architecture/` if the reasoning is genuinely load bearing, or lose it.
- Any restatement of what the code block above already shows.
- Any sentence introducing the next sentence.

## Modes

Set by path in the guard's `MODES` table, first match wins.

| Mode            | Holds                                             | Writes                                                                          |
| --------------- | ------------------------------------------------- | ------------------------------------------------------------------------------- |
| **Tutorial**    | `guide/02-first-steps.md`                         | One path through, in order, every step runnable. No alternatives, no asides     |
| **Reference**   | the rest of `guide/`, every published `README.md` | Signature, behaviour, failure mode. Tables over paragraphs. No narrative        |
| **Explanation** | `docs/architecture/*`, `guide/01-introduction.md` | The decision, the alternative, the measurement. This is where reasoning belongs |

A Reference page that wants to explain **why** links to the Explanation page.
It does not explain in place.

## What the guard measures

Three sentence shapes, budgeted per 100 prose lines because each is fine
occasionally and the defect is density. Measured against this repo before they
were picked: the generic AI vocabulary that circulates online scored **1** hit
across all of `docs/`, and these three scored **628**.

| Shape          | Looks like                                             | Fix                                                   |
| -------------- | ------------------------------------------------------ | ----------------------------------------------------- |
| **antithesis** | "Colour encodes the runtime, not the ranking"          | State what it does. Drop the correction               |
| **closer**     | "which is why", "that is the point", "is exactly what" | Delete the clause. The reader drew the conclusion     |
| **knowing**    | "deliberately", "by design", "the reason is"           | Delete, or move the reasoning to `docs/architecture/` |

Plus a paragraph length cap, which is the wall-of-prose axis, and a zero
tolerance list of marketing words and announcement sentences.

Fixing a budget failure by moving prose into a bullet list **passes the check
and fails the intent**. Lists are excluded from the paragraph measure so that
reference material stays in tables, not so prose can hide.

## Voice

- Assume a senior TypeScript developer. Never explain DI, HTTP or decorators as
  concepts. Explain what dunx does differently.
- Imperative. "Register this with" over "This can be registered by".
- Facts carry numbers. "55 ms boot" over "fast boot". If there is no
  measurement, there is no adjective.
- Open with a code block or an imperative sentence. Never with orientation.
- Inline comments inside a snippet beat a paragraph under it.

## Procedure

1. Run the guard. Note the file's mode and its three counts.
2. Read the whole file first. Most offences are one paragraph doing a job a
   table does better.
3. Cut top to bottom. Convert prose runs to tables where the content is
   genuinely tabular.
4. Re-run the guard on that file.
5. Check the rendered result if the file is under `docs/`:
   `bun run docs:build` regenerates `internal/docs/src/generated/`.

## Do not

- Do not add frontmatter to anything under `docs/`. The site generator does not
  strip it ([internal/docs/scripts/content.ts](../../../internal/docs/scripts/content.ts)),
  so it renders as literal text. The mode map lives in the guard instead.
- Do not renumber or rename a guide casually. The `NN-name.md` prefix is the nav
  order and the slug source in
  [internal/docs/scripts/generate.ts](../../../internal/docs/scripts/generate.ts),
  and published `#/guide/*` URLs depend on it.
- Do not add a file to the guard's Exempt list to make it pass.
- Do not touch the em dash rule's territory. `no-em-dash.test.ts` still applies.
