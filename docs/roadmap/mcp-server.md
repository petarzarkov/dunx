# An MCP server for dunx (`tools/mcp`)

**Open. Requested, not yet designed.**

A Model Context Protocol server so an agent working in a dunx app can ask the
framework about itself instead of grepping for the answer.

## Why this is worth having

The information an agent most often needs about a dunx app is already computed and
already structured, it is just not reachable without booting the app:

- **The route table.** `describeRoutes(module)` walks the module graph without
  constructing anything, so "what routes exist, with which schemas, guards and
  roles" is answerable with no database and no port.
- **The container graph.** `readDeps` plus the module records give every provider,
  what it depends on, and which module bound it - which is exactly what a
  missing-binding error makes someone reconstruct by hand.
- **The OpenAPI document.** Already derived from the same zod schemas.
- **The measurements.** `tools/bench/results/latest.json` is committed and
  structured.

An agent that can call those gets accurate answers instead of inferring from source.

## Shape to work out

`tools/mcp`, **private and never published** like the other tools, at least to
start. Open questions, in the order they need answering:

1. **Static, decided.** It reads the app; it does not boot it.

   Booting is the tempting option because it gives the resolved container, and it
   is the wrong one. `AppFactory.create` instantiates every provider and awaits
   every async factory before returning - that is the no-lazy-resolution decision -
   so booting an app to answer "what routes exist" opens database connections,
   starts queue workers, binds sockets and runs every `onInit`. An agent asking a
   question about the code would be running the code, with side effects, against
   whatever environment happened to be configured.

   Static costs nothing and needs nothing: `describeRoutes` walks prototypes with
   `Object.create`, so no constructor runs, and it already works with no database
   and no port - that is what `bunx dunx-openapi` is built on. It is also
   idempotent, which matters for a tool an agent calls repeatedly.

   The provider graph is reachable statically too, from the module records plus
   `readDeps`, which is the same pair the container itself reads.

   What static cannot give is runtime state: the actual value of a config field,
   whether the database is reachable. An agent should not be asking a
   code-inspection tool those. If one is ever genuinely needed, add it as a
   separately named tool whose description says it boots the app, so the cost is
   visible at the call site rather than hidden in every answer.

2. **Transport.** stdio is the obvious default for a local agent.
3. **Where does the app's root module come from?** The same question
   `scripts/gen-openapi.ts` in `dunx-template` runs into: a tool cannot guess an
   app's module factory or its config source. Probably a path argument plus a
   convention, and whatever is decided here should settle that script too.
4. **Does it ship?** A published `@dunx/mcp` would let any dunx app wire it up,
   which is the version with real value - but it inverts the "tools are private"
   rule, so it is a decision to record rather than assume.

## Constraints it inherits

- The dependency rules still apply to anything published. An MCP server over
  `Bun.serve` and
  stdio needs no dependency; a framework SDK would need justifying.
- If it stays in `tools/`, it may depend on anything - that is what `tools/bench`
  depending on express is allowed for.
