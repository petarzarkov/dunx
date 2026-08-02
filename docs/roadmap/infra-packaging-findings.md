# Four packaging and API findings in @dunx/infra

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
barrel. See also [ioredis-cjs-pin](./ioredis-cjs-pin.md).

## `SqliteOptions` and `SqlOptions` forward only `schema` to drizzle

**Missing feature. Medium.** `this.db = drizzle({ client: raw, schema })`, so
drizzle's `casing` and `logger` are unreachable from inside the container.
`casing: 'snake_case'` is the standard drizzle idiom and what `nestjs-template`
used; the query `logger` is how a slow endpoint gets diagnosed.

The template worked around it by spelling every column name out and dropping
`casing` from `drizzle.config.ts` so the runtime handle and drizzle-kit agree. A
`DB_LOG_QUERIES` env var was dropped as unimplementable.

## The root barrel is a partial re-export

**Low, but it costs time.** No queue symbols at all. `SyncDatabase`,
`SyncSqliteOptions`, `transactionSync` and `SqliteOptions` are on `/db` only, while
`DbModule`, `DbConnection`, `transaction` and `runSeeds` are on both. Guessing which
barrel has a symbol is trial and error. Either re-export everything or nothing.

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
