# @dunx/mcp

A [Model Context Protocol](https://modelcontextprotocol.io) server for
[dunx](https://github.com/petarzarkov/dunx). It answers two kinds of question: how
to write dunx, and what a particular dunx app contains.

## Usage

```bash
bunx @dunx/mcp                        # the guide, the starter, the feature catalogue
bunx @dunx/mcp ./src/app.module.ts    # those, plus the readers for your app
```

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

Drop the second argument until there is an app to read. Point it at the file that
declares your root module once there is: `@Module` leaves a marker, so a module
exported only by name is found on its own. `default` and `root` win if present, and
`--export=<name>` settles a file that declares several. The path goes through
`Bun.resolveSync`, so anything `import` accepts works.

## The tools

The [Agent tooling guide](../../docs/guide/21-agent-tooling.md) is canonical.

Three answer with no app, and are served whether or not an entry was given:

| Tool             | Answers                                                                      |
| ---------------- | ---------------------------------------------------------------------------- |
| `dunx_start`     | The runtime, the two ways to get an app, and the rules that fail at boot     |
| `dunx_guide`     | Every written chapter: the index, one chapter, or a search across them all  |
| `dunx_scaffold`  | Every feature `bunx @dunx/create-app` generates, and the smallest app        |

Six read the app, and appear once an entry is given:

| Tool             | Answers                                                       |
| ---------------- | ------------------------------------------------------------- |
| `dunx_overview`  | Counts, and every dependency whose type was erased            |
| `dunx_routes`    | Every route, its controller, guards and validated inputs      |
| `dunx_providers` | Every binding, the module that bound it, what it depends on   |
| `dunx_gateways`  | Every websocket gateway and the events it handles             |
| `dunx_modules`   | The module graph in traversal order                           |
| `dunx_openapi`   | The OpenAPI 3.1 document, when `@dunx/openapi` is installed   |

Every filter is optional. Omitting one means everything, so a caller that knows
nothing still gets a useful first answer.

## Resources

The guide chapters are also served as MCP resources at `dunx://guide/<slug>`, for a
client that attaches documents rather than calling tools. Chapter links inside them
are rewritten to the same scheme; links to the rest of the repository become
absolute.

## Notes

- **It reads the app and never boots it.** `AppFactory.create` would open database
  connections, start queue workers, and run every `onInit`. Asking a question about
  the code would then mean running the code. The cost of that is no runtime state:
  the value of a config field is not answerable here.
- It reads through the framework's own readers - `providersOf`, `modulesOf`,
  `routesOf`, `gatewaysOf` - so an answer cannot drift from what the container and
  the router actually do.
- The guide, the starter and the feature catalogue are bundled into the package from
  `docs/guide`, `examples/minimal` and `@dunx/create-app`. All three are what CI
  builds and boots, and a test fails when the committed bundle no longer matches
  them. Nothing is fetched at run time.
- No dependencies. `bunx @dunx/mcp` resolves nothing.
- `@dunx/openapi` is an optional peer, reached with `await import()`. Without it the
  other eight tools work and `dunx_openapi` reports what to install.

## License

MIT
