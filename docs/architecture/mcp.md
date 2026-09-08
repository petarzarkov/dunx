# The MCP server (`@dunx/mcp`)

**Shipped as `tools/mcp`.** Nine read-only tools. Six read an app -
`dunx_overview`, `dunx_routes`, `dunx_providers`, `dunx_gateways`, `dunx_modules`,
`dunx_openapi` - and three need none: `dunx_start`, `dunx_guide`, `dunx_scaffold`.
What follows is the reasoning that produced the first six, kept because the
decisions are still load-bearing, then the answers to the four questions it opened.
The three that need no app came later; their reasoning is the last section.

Two of those decisions are now load-bearing for a second consumer. The
static-not-boot rule is the one `@dunx/dashboard` inverts. The readers behind
these tools are what it needs too, so they belong in `@dunx/core` and
`@dunx/http` rather than here.

A Model Context Protocol server so an agent working in a dunx app can ask the
framework about itself instead of grepping for the answer.

## Why this is worth having

The information an agent most often needs about a dunx app is already computed and
already structured. It is just not reachable without booting the app:

- **The route table.** `describeRoutes(module)` walks the module graph without
  constructing anything, so "what routes exist, with which schemas, guards and
  roles" is answerable with no database and no port.
- **The container graph.** `readDeps` plus the module records give every provider,
  what it depends on, and which module bound it. That matches what a
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

   Booting is the tempting option because it gives the resolved container. It is
   also the wrong one. `AppFactory.create` instantiates every provider and awaits
   every async factory before returning: that is the no-lazy-resolution decision.
   Booting an app just to answer "what routes exist" opens database connections,
   starts queue workers, binds sockets, and runs every `onInit`. An agent asking a
   question about the code would be running the code, with side effects, against
   whatever environment happened to be configured.

   Static costs nothing and needs nothing. `describeRoutes` walks prototypes with
   `Object.create`, so no constructor runs. It already works with no database and
   no port, the same property `bunx dunx-openapi` is built on. It is also
   idempotent, which matters for a tool an agent calls repeatedly.

   The provider graph is reachable statically too, from the module records plus
   `readDeps`, the same pair the container itself reads.

   What static cannot give is runtime state: the actual value of a config field,
   whether the database is reachable. An agent should not be asking a
   code-inspection tool for those. If one is ever genuinely needed, add it as a
   separately named tool whose description says it boots the app. That keeps the
   cost visible at the call site rather than hidden in every answer.

2. **Transport.** stdio is the obvious default for a local agent.
3. **Where does the app's root module come from?** The same question
   `scripts/gen-openapi.ts` in `dunx-template` runs into: a tool cannot guess an
   app's module factory or its config source. Probably a path argument plus a
   convention. Whatever is decided here should settle that script too.
4. **Does it ship?** A published `@dunx/mcp` would let any dunx app wire it up:
   the version with real value. But it inverts the "tools are private"
   rule, so it is a decision to record rather than assume.

## Constraints it inherits

- The dependency rules still apply to anything published. An MCP server over
  `Bun.serve` and stdio needs no dependency. A framework SDK would need justifying.
- If it stays in `tools/`, it may depend on anything, as `internal/bench`
  depending on express is allowed for.

## How the four questions resolved

1. **Static, decided** - and it held. Every tool reads the graph and constructs
   nothing. `discoverRoutes` and `discoverGateway` both take an instance, and
   `Object.create(Class.prototype)` satisfies them: `instance.constructor` still
   resolves to the class, and every method is still reachable. So no constructor,
   or dependency of one, has to exist.

What made this cheaper than expected is that **nothing had to be reimplemented
to get it**. The graph comes from `collectModules`, `readControllers`,
`readDeps`, and `describeToken`. The routes and gateways come from http's own
discovery.

The last three were internal to their packages and are now exported. That is
the honest fix: a second reader of `Symbol.for('dunx.deps')` has to restate the
prototype-chain lookup, the lazy thunk call, and the shape of an `unresolved`
entry, and it silently drops any field that shape later gains. The first
version of this package did restate them. It rendered a `token()` binding as
`[object Object]` as a result.

2. **Transport: stdio**, as expected, and Bun-native throughout - `Bun.stdin.stream()`
   in, a `Bun.stdout.writer()` `FileSink` out, flushed per message. `Bun.resolveSync`
   locates the entry, which matters more than it sounds: it is the runtime's own
   resolver, so every specifier `import` accepts works. It follows Node resolution,
   so a bare _relative_ path throws: `src/app.module.ts` reads as a package named
   `src` (measured). An unresolved specifier is then retried as `./`-prefixed,
   tried as-is first so a real package still wins.

3. **Where the root module comes from**: a path argument plus the `default`/`root`
   convention, matching `bunx dunx-openapi`. `scripts/gen-openapi.ts` in the template
   should be settled the same way.

4. **It ships**, as `@dunx/mcp`. That inverts the "tools are private" rule
   knowingly. A published server is the version any dunx app can wire up. A
   private one under `tools/` would only ever serve this repo.

   **The OpenAPI document is in**, as `dunx_openapi`, with `@dunx/openapi` an
   _optional_ peer reached by `await import()`. That lets the other five tools
   work in an app with no OpenAPI setup, and it also explains why `dunx_routes`
   reports _which_ inputs a route validates rather than their schemas:
   converting a schema to JSON Schema is zod-specific work `@dunx/openapi`
   already does. A second, worse generator here would be the "never invent what
   a mature library solves" failure.

   **The benchmark results are still out.** `internal/bench/results/latest.json`
   describes this repo rather than the app being read, so a tool exposing it would answer a
   question nobody holding a dunx app is asking.

## The entry became optional

The server required a root module. Every tool read one, so `bunx @dunx/mcp` with no
argument printed usage and exited 1.

That made it unreachable during adoption. Someone installing dunx for the first time
has no root module to point at, and an agent asked to add dunx to an existing project
has nothing to point at either. The server's answers were all conditioned on having
already succeeded at the part that is hardest to get right.

Three tools now answer with no app, and are served whether or not an entry was given:

- **`dunx_start`** - the runtime, the scaffold command, the two install commands and
  the `bunfig.toml` that add dunx to a project that already exists, an index of the
  guide, and `BOOT_RULES`. Those are the failures with no compiler behind them, and
  `tools/create-app/src/rules.ts` is the list: the missing preload heads it, and the
  scaffolded `AGENTS.md` renders the same one. It is 4 KB. The first version was
  17 KB, because it embedded each
  chapter's summary and section headings into a map whose job is to say which
  chapter to ask for next; `Guide.titles()` is what replaced `Guide.index()` there,
  and `adopt.test.ts` holds it under 6 KB.
- **`dunx_guide`** - every chapter of `docs/guide`. No arguments returns the index;
  `search` returns matching lines with chapter and line number, capped at five per
  chapter and forty overall so a common word is not answered entirely out of
  `01-introduction`, and reporting how many it omitted; `topic`
  returns one chapter in full, resolving an exact slug, then a slug substring, then a
  title substring.
- **`dunx_scaffold`** - `@dunx/create-app`'s own catalogue, and the starter files.

### The corpus is bundled, not fetched

`docs/guide`, `examples/minimal` and `tools/create-app` are all outside the package,
and `files` cannot reach outside a package directory. So `scripts/gen-mcp-corpus.ts`
writes `tools/mcp/src/generated.ts`, committed and rewritten by `bun run gen:mcp`.
Same arrangement as `packages/dashboard/src/ui-bundle.ts`, and 439 KB against its
445 KB.

**`build` does not regenerate it, and that is the whole point.** It did, and `build`
is the first phase of `bun run ci`, so `gen-mcp-corpus.test.ts` compared a file the
build had rewritten seconds earlier: a guide edit committed without regenerating was
never flagged, by the test written to flag exactly that. `gen:readme --check` is the
pattern that works, and it works because nothing writes the file before the check.

Fetching from `dunx.win` was the alternative and it is worse in three ways: it fails
offline, it fails behind a network policy an agent does not control, and it can serve
a guide for a version other than the installed one.

`scripts/gen-mcp-corpus.test.ts` re-renders and compares against the committed file,
because a guide edit that never ran the generator would ship a corpus describing the
previous release and nothing else would notice - it compiles, and it answers
confidently. That is the failure `gen:readme --check` exists for.

The whole corpus is three `JSON.parse` calls over one string literal each, which
keeps the file at 13 lines. An object literal spanning ten thousand lines would give
`max-lines` and `oxfmt` an opinion about generated data.

Every input is something CI already builds, boots or tours. The starter is
`examples/minimal/src` plus the base template's `bunfig.toml` and `tsconfig.json`,
which is exactly what `bunx @dunx/create-app` writes for an empty selection.

### Resources, and the note that said to take the SDK

`protocol.ts` carried a note saying to take `@modelcontextprotocol/sdk` if the server
ever grew resources. It grew them and the note was wrong: `resources/list` and
`resources/read` are two more methods of the shape the other four already have, about
forty lines, and a dependency would have bought nothing.

`resources/templates/list` is answered with an empty list rather than left to
`-32601`. Declaring the `resources` capability is what makes a client ask, and
several log the method-not-found as a broken server.

What would still justify the SDK: sampling, elicitation, progress, or a transport
that is not stdio. Each of those is a session and a lifetime rather than another
request and response.

`handle` and `serve` take resources as an optional trailing argument, so a caller
that serves none keeps working unchanged.
