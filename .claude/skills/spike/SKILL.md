---
name: spike
description: Resolve an open technical question by measuring it on real Bun instead of assuming, then record the verified result in docs/architecture/constraints.md. Use for an open item in docs/ROADMAP.md that turns on runtime behaviour, before committing to any API shape that depends on runtime or tsc behaviour, and whenever a design argument turns on "does Bun/TypeScript actually do X?".
---

# /spike

An entry in [docs/architecture/constraints.md](../../../docs/architecture/constraints.md)
cites the probe or type-check output it rests on, which is why the decisions built
on it hold. A spike adds entries of that kind. Open questions live in the **Open items** section of
[docs/ROADMAP.md](../../../docs/ROADMAP.md), one file each under
`internal/notes/roadmap/`.

## Procedure

1. **State the question as a falsifiable claim** and name what it gates, for
   example "does `@Post(path, { body: Schema })` constrain the method signature
   through the method decorator's generic?" gates the typed-input API.
2. **Write a throwaway probe in the scratchpad directory**, never under
   `packages/` or `examples/`. It is not code that ships and it must not reach a
   commit, a coverage run, or a build.
3. **Run it on real Bun** and record `bun --version` alongside the output. A
   type-level question runs through the repo's `tsc` instead; record its version.
4. **Delegate the probing when it is noisy or wide.** Give a subagent the claim
   and the probe location; ask back for the literal command, the literal output,
   and a one-line verdict. Iterating a decorator probe through six type errors is
   exactly the kind of output that should never enter the main thread.
5. **Record the result** in docs/architecture/constraints.md, under the topic it
   belongs to:
   - confirmed → an entry with the command, the Bun version, and the literal
     output in a fenced block. Match the existing terseness - the
     `paramtypes: [ "Db", "Object", "Number" ]` entry is the model.
   - refuted → write down the fallback and why, under the decision it affects.
     A rejected approach recorded is the whole point of that document.
   - If the question came from an **Open items** row in docs/ROADMAP.md, update
     its file under `internal/notes/roadmap/`, or delete it and the row when the
     spike settles it. A resolved question left listed is worse than no list.
6. **Delete the probe.**

## Rules

- Never write "should work", "presumably", or "in theory" into
  docs/architecture/constraints.md. If it was not run, it does not go in.
- A spike that changes the public API shape belongs **before** the code it gates,
  not after.
- One spike, one claim. Two questions are two probes.
- Probes may use anything - including the dialects this repo bans in shipped code
  (`experimentalDecorators`, `reflect-metadata`) if refuting them is the point.
  That is how the existing `emitDecoratorMetadata` entry was produced. Scratchpad
  only.
