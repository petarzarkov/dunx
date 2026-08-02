---
name: spike
description: Resolve an open technical question by measuring it on real Bun instead of assuming, then record the verified result in docs/architecture/constraints.md. Use for the "Spikes to resolve" items, before committing to any API shape that depends on runtime or tsc behaviour, and whenever a design argument turns on "does Bun/TypeScript actually do X?".
---

# /spike

Every constraint in the **Verified constraints** section of
[docs/ARCHITECTURE.md](../../../docs/ARCHITECTURE.md) was measured, not reasoned about.
That is why the decisions above it hold. A spike keeps that property.

## Procedure

1. **State the question as a falsifiable claim** and name what it gates. From
   docs/architecture/constraints.md: "does `@Post(path, { body: Schema })` constrain the
   method signature through the method decorator's generic?" gates Phase 3.
   "Does the `WeakMap` pending-drain survive subclassed controllers without
   `Symbol.metadata`?" gates Phase 2.
2. **Write a throwaway probe in the scratchpad directory**, never under
   `packages/` or `examples/`. It is not code that ships and it must not reach a
   commit, a coverage run, or a build.
3. **Run it on real Bun** and record `bun --version` alongside the output.
4. **Delegate the probing when it is noisy or wide.** Give a subagent the claim
   and the probe location; ask back for the literal command, the literal output,
   and a one-line verdict. Iterating a decorator probe through six type errors is
   exactly the kind of output that should never enter the main thread.
5. **Record the result** in docs/ARCHITECTURE.md:
   - confirmed → a **Verified constraints** entry with the command, the Bun
     version, and the literal output in a fenced block. Match the existing
     terseness - the `paramtypes: [ "Db", "Object", "Number" ]` entry is the
     model.
   - refuted → write down the fallback and why, under the decision it affects.
     A rejected approach recorded is the whole point of that document.
   - Remove the item from **Spikes to resolve**. A resolved spike left listed is
     worse than no list.
6. **Delete the probe.**

## Rules

- Never write "should work", "presumably", or "in theory" into
  docs/ARCHITECTURE.md. If it was not run, it does not go in.
- A spike that changes the public API shape belongs **before** the code it gates,
  not after.
- One spike, one claim. Two questions are two probes.
- Probes may use anything - including the dialects this repo bans in shipped code
  (`experimentalDecorators`, `reflect-metadata`) if refuting them is the point.
  That is how the existing `emitDecoratorMetadata` entry was produced. Scratchpad
  only.
