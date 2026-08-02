# bullmq 6.0.5's CJS build breaks on ioredis 6

**Open. Known, currently harmless.**

bullmq 6.0.5's CommonJS build imports `ioredis/built/utils`, which ioredis 6
removed. The ESM build does not, which is why the suite passes and why nothing has
broken.

`ioredis` is an optional peer purely because bullmq's barrel imports it statically
despite documenting it as optional. dunx never imports it: `@dunx/infra/queue` uses
bullmq's `createBunRedisClient` over `Bun.RedisClient`, and `dist/` contains no
reference to ioredis.

## What to do

Pin ioredis 5 if anything might load the CJS entry. Today nothing does, so the pin
would be insurance against a change in bullmq's resolution or a consumer bundling
for CJS.

There is a related skew worth fixing at the same time: the peer range is `>=5.0.0`
and the dev dependency is `^6.0.0`, so CI only ever exercises 6.x while the
manifest claims 5 works.
