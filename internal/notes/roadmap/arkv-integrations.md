# Gaps in `@arkv/logger` that dunx works around

`@dunx/infra/logger` re-exports upstream rather than restating it, so every entry
below is a place dunx has to copy or cast around instead. Each one disappears if
upstream takes it. Checked against `@arkv/logger@0.13.0`.

## 1. `isDevelopment` defaults from `NODE_ENV`, with no terminal check

Upstream's colour switch is `isDevelopment`, defaulted from
`process.env.NODE_ENV !== 'production'`. Nothing on that path asks whether the
output is a terminal, so a container with `NODE_ENV` unset writes ANSI escapes
into its JSON and the logs stop parsing.

**dunx's workaround.** `LoggerModule` passes
`isDevelopment: settings.isDevelopment ?? Bun.enableANSIColors`, and the consumer
still wins. `Bun.enableANSIColors` already folds in TTY, `NO_COLOR` and
`FORCE_COLOR`, which is the question actually being asked. This is the
Bun-specific half; the portable half is a Node default upstream.

**The ask.** Default `isDevelopment` from a terminal check rather than from
`NODE_ENV` alone.

## 2. A sink is handed a sanitized entry, but `LogEntry.error` is typed `Error`

`Transport.write(entry: LogEntry, level)` is documented as receiving the
**sanitized** entry, and `sanitizeLogEntry` replaces an `Error` with its
serialized form. Upstream still declares:

```ts
export type LogEntry = Record<string, unknown> & {
  error?: Error;
};
```

so the declared type contradicts what the value holds.

**dunx's workaround.** `@dunx/core` declares `LogEntry.error` as
`Error | SerializedError`, which is what makes a filter able to hand an entry
back. The two disagree in one direction only, so `FilteringTransport.write`
carries a single cast where the filtered entry is passed on. One cast, documented
at the site, and this is the reason it exists.

**The ask.** Widen the declaration to `Error | SerializedError`, or to whatever
the sanitizer actually produces.

## 3. The default console transport is constructed privately

A config with no `transports` gets one built inside the logger:

```js
this.#transports = cfg.transports ?? [
  new ConsoleTransport({
    batch: cfg.batchConsole ?? false,
    format: isDevelopment ? prettyFormat : jsonFormat,
  }),
];
```

That is invisible from outside, so anything that has to sit **between the entry
and the transports** cannot wrap it. There is no seam: `filters` has to be a
`LoggerConfig` field to apply to the default sink, and dunx builds the default
itself to have something to wrap.

**dunx's workaround.** `filteredTransports` copies those two choices when the
config names no `transports`, because `LoggerModule.forRoot({ filters })` with no
`transports` is the case the option invites. The copy is the one place this wiring
can drift, so a test asserts that dunx's rebuilt default renders byte-identically
to upstream's own for the same config.

**That assertion only bites with colours on.** Without them `jsonFormat` and
`prettyFormat` render identical bytes - measured on flat, nested, error and long
entries, all four the same - so a rendering comparison cannot see a wrong `format`
at all and would pass whether the copy were right or wrong. The guard therefore
checks the two formatters differ before it asserts anything, and **skips** when
they do not, rather than reporting a green that cannot fail. `FORCE_COLOR=1` (or a
TTY) makes it run. The consequence: in a colourless CI the `format` half of this
copy is unverified, and only the `batch` half is exercised.

**The ask.** Either an entry hook in `LoggerConfig` that runs before the
transports, next to the existing `maskFields`, `filterEvents` and `serializers`,
or a way to reach the default transport so a wrapper can be composed around it.
The first is the smaller change and the one dunx would drop its copy for.
