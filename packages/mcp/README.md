# @dunx/mcp

A [Model Context Protocol](https://modelcontextprotocol.io) server that answers
questions about a dunx application, so an agent working in one can ask the framework
instead of grepping for the answer.

```bash
bunx @dunx/mcp ./src/app.module.ts
```

The entry exports its root module as `default` or `root` - the same convention
`bunx dunx-openapi` uses.

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

| Tool              | Answers                                                                          |
| ----------------- | -------------------------------------------------------------------------------- |
| `dunx_routes`     | Every route, with its controller, handler, module, `@Public()` and `@Roles()`      |
| `dunx_providers`  | Every controller with the constructor dependencies recorded for it                |
| `dunx_modules`    | The module graph in traversal order                                              |

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

## No dependencies

The protocol here is newline-delimited JSON-RPC 2.0 with three methods -
`initialize`, `tools/list`, `tools/call` - and it is about sixty lines in
`src/protocol.ts`. dunx's rule against reinventing mature libraries is aimed at ORMs,
validators, auth flows and job queues, where the library is years of edge cases; a
framing loop is not that, and hand-writing it is what lets `bunx @dunx/mcp` resolve
nothing at all.

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

Minimal on purpose. Three read-only tools and the protocol subset they need. The
open questions - whether the OpenAPI document and the benchmark results are worth
exposing, and whether a `@dunx/mcp` in a consumer's own dependencies beats a `bunx`
invocation - are in
[docs/roadmap/mcp-server.md](https://github.com/petarzarkov/dunx/blob/main/docs/roadmap/mcp-server.md).
