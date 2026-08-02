# Two remaining packaging findings in @dunx/infra

Two of the original four are fixed: `SqliteOptions` and `SqlOptions` now forward
drizzle's `casing` and `logger` through `DrizzleInit`, and the root barrel is the
full union of every area it carries with `/queue` as the single documented
exception - see ARCHITECTURE.md, "Database layer" and `packages/infra/README.md`.

## `/queue` cannot be imported without ioredis, which is marked optional

**Packaging fault. Medium.** With `bullmq@6.0.5` present and `ioredis` absent -
which is the default, since bullmq 6 does not depend on it:

```
error: Cannot find module 'ioredis/built/utils' from
  node_modules/bullmq/dist/cjs/utils/index.js
```

Every other subpath imports fine. `peerDependenciesMeta.ioredis.optional: true`
means nothing warns. The manifest contradicts guide 14, which correctly says
`bun add bullmq ioredis`. Either `ioredis` is not optional whenever `/queue` is
imported, or `/queue`'s barrel should stop transitively reaching bullmq's CJS
barrel. See also [ioredis-cjs-pin](./ioredis-cjs-pin.md), which is where the
decision belongs.

This is also the whole reason `/queue` is the one area the root barrel does not
re-export. `packages/infra/src/index.test.ts` asserts both halves, so whichever way
this is resolved, the test says whether the exception can go.

## `@dunx/infra/logger` emits ANSI to a non-TTY when `isDevelopment: true`

**Low. Probably belongs upstream in `@arkv/logger`.** With
`Bun.enableANSIColors === false` and `process.stdout.isTTY === undefined`, the JSON
is still coloured and therefore unparseable:

```
{^[[36m"level":^[[39m^[[42m^[[30m"info"^[[39m^[[49m,...
```

`isDevelopment: false` is clean. `isDevelopment` is normally derived from `NODE_ENV`
rather than from whether stdout is a terminal, so any non-production container or CI
job piping logs hits it.
