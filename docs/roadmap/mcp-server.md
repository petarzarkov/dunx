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

1. **Does it boot the app or read it statically?** Static is far more useful: it
   works with no services, cannot have side effects, and `describeRoutes` was
   built for exactly that. Booting would add the resolved container but needs a
   database.
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
