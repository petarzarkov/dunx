# Emitted JS loses DI and the error tells you to do what you already did

**Bug (misleading diagnostic) plus documentation gap. High.**

`@dunx/transform/preload` registers its plugin with `filter: /\.tsx?$/`, so it never
sees an emitted `.js`. Run a transpiled tree and:

```
AppError: DatabaseBootstrap declares 1 constructor parameter(s) but no dependencies
were recorded ... Register the plugin, then retry:

  preload = ["@dunx/transform/preload"]
```

**That preload was already there and cannot help.** The real fix,
`Bun.build({ plugins: [depsPlugin] })`, is never mentioned in the message.

Reproduce with any file-per-file transpile, then `bun dist/main.js`.

## Fix

The error can detect that the failing module's path ends in `.js` and say "the
preload plugin only matches `.ts`; a prebuilt tree needs `depsPlugin` at build
time". Guide 17 documents `depsPlugin` for bundled builds; the error should point
there.
