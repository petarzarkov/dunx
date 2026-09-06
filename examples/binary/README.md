# @dunx/example-binary

How you ship a dunx app as one self-contained executable. A small CLI - the same
container, config and lifecycle a server uses - compiled with `bun build --compile`
into a single file that runs on a host with nothing installed.

```bash
bun install
bun run build          # -> dist/pulse (the Bun runtime plus the app, one file)
cd /tmp && "$OLDPWD/dist/pulse" report
```

```bash
bun run --filter '@dunx/example-binary' test
```

The app is a CLI, [`src/main.ts`](./src/main.ts), dispatching three commands over
the container:

| Command          | Shows                                                             |
| ---------------- | ---------------------------------------------------------------- |
| `pulse greet <name>` | An injected `GreeterService` - JSON on stdout, a log on stderr |
| `pulse report`   | A `ReportService` reading the typed config                       |
| `pulse version`  | Answering before the container is built                          |

## The build is one pass

[`scripts/build.ts`](./scripts/build.ts) hands `Bun.build` both the
`@dunx/transform` plugin and `compile`. Constructor injection has no runtime
annotation, so the plugin records each class's dependencies as a statement after
it.

At `bun run` time `bunfig.toml`'s preload does that; a compiled binary has no
load-time plugin, so the records are baked in at build time instead. `bun run test`
compiles the binary and asserts a resolved dependency survived.

On Bun 1.4.0 the marker was dropped when the plugin and `compile` ran together,
and the workaround was to bundle first and compile the emitted JavaScript. That
was fixed in 1.4.1, which is dunx's minimum.

## The version comes from a JSON import

[`src/config/settings.ts`](./src/config/settings.ts) reads the version with
`import pkg from '../../package.json'`. A compiled binary resolves `process.env` at
runtime and ignores `--define`, so a JSON import is the stamping that survives
`--compile`: the manifest version and the version the binary prints cannot
disagree.

## Logs go to stderr

[`src/cli.module.ts`](./src/cli.module.ts) points the logger at a single
`StreamTransport` on `process.stderr`. The default console logger splits info to
stdout, but `greet` and `report` print JSON on stdout that a caller parses, and a
log line there would corrupt it. Everything on stderr keeps `pulse report | jq .version`
working.

## Running the binary

Run it from a directory without this example's `bunfig.toml`. A standalone bun
executable still reads `preload` from the working directory's bunfig and tries to
load `@dunx/transform/preload`, which the binary no longer needs and cannot
resolve. A deployment host has no such file, so this is only a concern inside the
repo; the test runs the binary from a temp directory for the same reason.

## Constructor injection

`bunfig.toml` preloads `@dunx/transform` for `bun run` and `bun test`, which
records each class's constructor parameter types so the container can resolve them.
The compiled binary gets those same records at build time instead.
