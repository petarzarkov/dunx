# @dunx/mcp

A [Model Context Protocol](https://modelcontextprotocol.io) server that answers
questions about a [dunx](https://github.com/petarzarkov/dunx) application, so an
agent working in one can ask the framework instead of grepping for the answer.

## Usage

```bash
bunx @dunx/mcp ./src/app.module.ts
```

Point it at the file that declares your root module. `@Module` leaves a marker,
so a module exported only by name is found on its own; `default` and `root` win
if present, and `--export=<name>` settles a file that declares several. The path
goes through `Bun.resolveSync`, so anything `import` accepts works.

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

The [Agent tooling guide](../../docs/guide/21-agent-tooling.md) is canonical.

| Tool               | Answers                                                  |
| ------------------ | ---------------------------------------------------------- |
| `list_routes`      | Every route, its verb, path, controller and metadata      |
| `list_gateways`    | Every WebSocket gateway and the events it handles         |
| `list_providers`   | What is bound, in which module, and what it depends on    |
| `list_modules`     | The import graph                                          |
| `describe_route`   | One route in full, with its schemas when `@dunx/openapi` is installed |

Every filter is optional, and omitting one means everything, so a caller that
knows nothing still gets a useful first answer.

## Notes

- **It reads the app and never boots it.** `AppFactory.create` would open
  database connections, start queue workers and run every `onInit`, so an agent
  asking a question about the code would be running the code. The cost of that
  is no runtime state: the value of a config field is not answerable here.
- It reads through the framework's own readers - `providersOf`, `modulesOf`,
  `routesOf`, `gatewaysOf` - so an answer cannot drift from what the container
  and the router actually do.
- No dependencies. The protocol slice it needs is newline-delimited JSON-RPC 2.0
  with three methods, so `bunx @dunx/mcp` resolves nothing.
- `@dunx/openapi` is an optional peer, reached with `await import()`. Without it
  the server still works and `describe_route` omits the schemas.

## License

MIT
