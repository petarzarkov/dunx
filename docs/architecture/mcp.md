# The MCP server (`@dunx/mcp`)

**Shipped as `tools/mcp`.** Six read-only tools: `dunx_overview`, `dunx_routes`,
`dunx_providers`, `dunx_gateways`, `dunx_modules`, `dunx_openapi`. What follows is the
reasoning that produced it, kept because the decisions are still the load-bearing
ones; the answers to the four questions it opened are recorded at the bottom.

Two of those decisions are now load-bearing for a second consumer. The
static-not-boot rule is the one `@dunx/dashboard` inverts, and the readers behind
these tools are the ones it needs, so they belong in `@dunx/core` and
`@dunx/http` rather than here.

A Model Context Protocol server so an agent working in a dunx app can ask the
framework about itself instead of grepping for the answer.

## Why this is worth having

The information an agent most often needs about a dunx app is already computed and
already structured, it is just not reachable without booting the app:

- **The route table.** `describeRoutes(module)` walks the module graph without
  constructing anything, so "what routes exist, with which schemas, guards and
  roles" is answerable with no database and no port.
- **The container graph.** `readDeps` plus the module records give every provider,
  what it depends on, and which module bound it, matching what a
  missing-binding error makes someone reconstruct by hand.
- **The OpenAPI document.** Already derived from the same zod schemas.
- **The measurements.** `internal/bench/results/latest.json` is committed and
  structured.

An agent that can call those gets accurate answers instead of inferring from source.

## The shape, and how it was worked out

It was scoped as `tools/mcp`, private and never published like the other tools. It
shipped as `tools/mcp` instead, because an agent working in a consumer's app needs
it installed there rather than in this repo. Four questions had to be answered first,
in the order they gated each other:

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
   and no port, which `bunx dunx-openapi` is built on. It is also
   idempotent, which matters for a tool an agent calls repeatedly.

   The provider graph is reachable statically too, from the module records plus
   `readDeps`, the same pair the container itself reads.

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
   the version with real value - but it inverts the "tools are private"
   rule, so it is a decision to record rather than assume.

## Constraints it inherits

- The dependency rules still apply to anything published. An MCP server over
  `Bun.serve` and
  stdio needs no dependency; a framework SDK would need justifying.
- If it stays in `tools/`, it may depend on anything, as `internal/bench`
  depending on express is allowed for.

## How the four questions resolved

1. **Static, decided** - and it held. Every tool reads the graph and constructs
   nothing. `discoverRoutes` and `discoverGateway` both take an instance, and
   `Object.create(Class.prototype)` satisfies them: `instance.constructor` still
   resolves to the class and every method is still reachable, so no constructor - or
   dependency of one - has to exist.

What made this cheaper than expected is that **nothing had to be reimplemented
to get it**. The graph comes from `collectModules`, `readControllers`,
`readDeps` and `describeToken`; the routes and gateways from http's own
discovery.

The last three were internal to their packages and are now exported, which is
the honest fix: a second reader of `Symbol.for('dunx.deps')` has to restate the
prototype-chain lookup, the lazy thunk call and the shape of an `unresolved`
entry, and silently drops any field that shape later gains. The first version
of this package did restate them, and rendered a `token()` binding as `[object
Object]` as a result.

2. **Transport: stdio**, as expected, and Bun-native throughout - `Bun.stdin.stream()`
   in, a `Bun.stdout.writer()` `FileSink` out, flushed per message. `Bun.resolveSync`
   locates the entry, which matters more than it sounds: it is the runtime's own
   resolver, so every specifier `import` accepts works. It follows Node resolution, so
   a bare _relative_ path throws - `src/app.module.ts` reads as a package named `src`
   (measured) - and an unresolved specifier is retried as `./`-prefixed, as-is first
   so a real package still wins.

3. **Where the root module comes from**: a path argument plus the `default`/`root`
   convention, matching `bunx dunx-openapi`. `scripts/gen-openapi.ts` in the template
   should be settled the same way.

4. **It ships**, as `@dunx/mcp`. That inverts the "tools are private" rule
   knowingly: a published server is the version any dunx app can wire up, and a
   private one under `tools/` would only ever serve this repo.

   **The OpenAPI document is in**, as `dunx_openapi`, with `@dunx/openapi` an
   _optional_ peer reached by `await import()`, which lets the other five tools
   work in an app with no OpenAPI setup, and it is why `dunx_routes` reports _which_
   inputs a route validates rather than their schemas: converting a schema to JSON
   Schema is zod-specific work `@dunx/openapi` already does, and a second, worse
   generator here would be the "never invent what a mature library solves" failure.

   **The benchmark results are still out.** `internal/bench/results/latest.json`
   describes this repo rather than the app being read, so a tool exposing it would answer a
   question nobody holding a dunx app is asking.
