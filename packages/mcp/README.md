# @dunx/mcp

A [Model Context Protocol](https://modelcontextprotocol.io) server that answers
questions about a dunx application, so an agent working in one can ask the framework
instead of grepping for the answer.

```bash
bunx @dunx/mcp ./src/app.module.ts
```

Point it at the file that declares your root module. There is no naming convention
to satisfy: `@Module` leaves a marker, so a module exported only by name - which is
what `@dunx/create-app` scaffolds and what every example here does - is found on its
own. `default` and `root` win if present, and `--export=<name>` settles a file that
declares several.

The path is resolved with `Bun.resolveSync`, so anything `import` accepts works:
`./src/app.module.ts`, a bare `src/app.module.ts`, an absolute path, an
extensionless specifier, or a package name.

## Wiring it into a client

```json
{
  "mcpServers": {
    "dunx": {
      "command": "bunx",
      "args": ["@dunx/mcp", "./src/app.module.ts"]
    }
  }
}
```

## The tools

| Tool             | Answers                                                                                                        |
| ---------------- | -------------------------------------------------------------------------------------------------------------- |
| `dunx_overview`  | Counts, plus every constructor dependency whose type was erased. The cheapest first call                        |
| `dunx_routes`    | Every route: controller, handler, module, guards, `@Public()`/`@Roles()`, status, and which inputs it validates |
| `dunx_providers` | Every registration - controllers, gateways, `useClass`, `useValue`, `useFactory` - with its dependencies        |
| `dunx_gateways`  | Every websocket gateway, its path, and the handler each `@OnMessage` event lands on                             |
| `dunx_modules`   | The module graph in traversal order, and what each module contributes                                           |
| `dunx_openapi`   | The OpenAPI 3.1 document, with the real request and response JSON Schemas                                      |

Every tool takes optional filters and nothing else - `dunx_routes { method, path,
controller, module, publicOnly }`, `dunx_providers { module, token, role,
unresolvedOnly }`. Omitting them means everything, so a caller that knows nothing
still gets a useful first answer; they exist because a large app's full route table
is a lot of tokens to hand a model that asked about one path.

### Which inputs, or which schemas

`dunx_routes` reports **that** a route validates its body, and by which Standard
Schema vendor. It does not report the schema. Turning one into JSON Schema is
zod-specific work that `@dunx/openapi` already does properly, so `dunx_openapi` is
where it lives - and that split is what keeps the other five tools working in an app
with no OpenAPI setup at all.

`@dunx/openapi` is an **optional** peer, reached with `await import()` only when
`dunx_openapi` is called. Without it that one tool fails with what to install and
the rest are unaffected.

## It reads the app. It never boots it.

This is the decision the package is built around, so it is worth stating plainly.

`AppFactory.create()` instantiates every provider and awaits every async factory
before it returns - dunx has no lazy resolution, deliberately. So booting an app to
answer "what routes exist" would open database connections, start queue workers, bind
sockets and run every `onInit`. An agent asking a question about the code would be
running the code, with side effects, against whatever environment happened to be
configured.

Reading costs none of that. `discoverRoutes` walks a prototype chain, and
`Object.create(Controller.prototype)` is that chain with nothing behind it: every
method is reachable and no constructor runs. The dependency graph comes from the same
two sources the container reads - each module's registrations, and the record
`@dunx/transform` wrote.

**What that rules out is runtime state.** The value of a config field, or whether the
database is reachable, is not answerable here. If one of those is ever genuinely
needed it belongs in a separately named tool whose description says it boots the app,
so the cost is visible at the call site rather than hidden inside every answer.

## It reads it through the framework's own readers

Nothing here re-implements traversal. The graph comes from `collectModules`,
`readControllers`, `readDeps` and `describeToken` in `@dunx/core`; the routes from
`discoverRoutes`, and the gateways from `discoverGateway`, in `@dunx/http`. Both
discovery functions take an instance, and `Object.create(Class.prototype)` satisfies
them: the constructor still resolves, every method is still reachable, and nothing
runs.

`readDeps`, `isUnresolved` and `describeToken` were internal to `@dunx/core` until
this package needed them. A second reader of `Symbol.for('dunx.deps')` would have to
restate the prototype-chain lookup, the lazy thunk call and the shape of an
`unresolved` entry - and would silently drop any field that shape ever gains, which
is how a token ends up rendered as `[object Object]`.

## No dependencies

The protocol here is newline-delimited JSON-RPC 2.0 with four methods -
`initialize`, `ping`, `tools/list`, `tools/call` - and it is about eighty lines in
`src/protocol.ts`. dunx's rule against reinventing mature libraries is aimed at ORMs,
validators, auth flows and job queues, where the library is years of edge cases; a
framing loop is not that, and hand-writing it is what lets `bunx @dunx/mcp` resolve
nothing at all.

`ping` is base protocol rather than part of any capability, so a server that declares
only `tools` still has to answer it: a client sends it to check the connection is
alive and reads a `-32601` as a dead server.

If this ever grows resources, prompts, sampling or progress notifications, take
[`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol/typescript-sdk)
instead. At that point the protocol surface stops being something worth hand-holding.

`@dunx/core` and `@dunx/http` are peer dependencies: this reads *your* app's module
graph, so it has to be the same copy of them your app uses.

**That failure is silent, so it is worth knowing the shape of it.** `metaKey` mints a
fresh `Symbol(name)` per call - deliberately, so two libraries that both name a key
`roles` can never read each other's value. `PUBLIC` and `ROLES` are therefore
module-level singletons of `@dunx/http`, and a second copy of that package has
*different symbols*. Nothing throws: `dunx_routes` just reports every route as
`public: false` with `roles: null`. Encountered while testing this package against a
fixture whose `node_modules` resolved a second copy.

The same applies to `@dunx/core`, where two copies means two different class objects
and a token *is* a class object.

## Status

Six read-only tools and the protocol subset they need. Still open: whether the
benchmark results are worth exposing, which is a question about this repo rather than
about an app being read. See
[docs/roadmap/mcp-server.md](https://github.com/petarzarkov/dunx/blob/main/docs/roadmap/mcp-server.md).
