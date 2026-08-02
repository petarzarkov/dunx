# What AsyncLocalStorage costs, and whether anything is cheaper

**Status:** measured. The first half is answered; the second half found a Bun bug.

`@arkv/logger`'s context store and dunx's own `AsyncRequestContext` are both
`AsyncLocalStorage`. The question was whether that is expensive and whether a
native or better-suited alternative exists.

## What it costs

`bun run logging` in `tools/bench` decomposes request logging one step at a time.
The `runWithContext` row is the answer:

| step                                    | adds         |
| --------------------------------------- | ------------ |
| a middleware that only calls `next()`   | +0.05 us     |
| the pathname sliced out of `req.url`    | +0.73 us     |
| `x-request-id` and `user-agent` read    | +1.29 us     |
| `crypto.randomUUID()`                   | +0.04 us     |
| **`runWithContext` around the handler** | **+0.91 us** |
| the entry object and `Logger` dispatch  | +0.80 us     |
| the entry and `JSON.stringify`          | +2.04 us     |
| the write, unbatched                    | +1.24 us     |

Request logging as shipped costs 5.38 us over `requestLogging: false`, so
`AsyncLocalStorage` is **17% of it** and about 6% of a logged request. It is the
third-largest component, behind `JSON.stringify` and the write, and comfortably
ahead of anything else. It is not the problem.

## Whether anything is cheaper

The obvious candidate is `enterWith()`, which sets the store for the current
execution without wrapping a callback and so should skip an async frame.

**It cannot be used: `enterWith()` segfaults Bun 1.3.14.** Three lines:

```ts
import { AsyncLocalStorage } from 'node:async_hooks';
const als = new AsyncLocalStorage<number>();
als.enterWith(1);
await Promise.resolve(); // panic(main thread): Segmentation fault
```

`enterWith` alone is fine; `enterWith` followed by any `await` is not. One call is
enough, and `run()` is unaffected at any iteration count. Recorded in
[bun-apis.md](../bun-apis.md).

So dunx's use of `run()` is not a choice between two working options - it is the
only one that works. Worth re-checking when Bun fixes it, because a working
`enterWith` would remove an async frame from every request.

## What is left to try

- **A plain module-level variable** measured 122 ns/op against 160 for an explicit
  argument in a microbenchmark, so it is not obviously faster and it is wrong under
  concurrency: one in-flight request would overwrite another's context. Not viable.
- **Skipping the store when nothing reads it.** The scope exists so a service
  logging deep in a call stack is correlated without being handed a request object.
  An app that never does that pays 0.91 us for nothing. A flag that turns the scope
  off, or detecting that no logger reads it, would recover that.
- Re-measure after any Bun upgrade. This is a runtime primitive and its cost is
  Bun's, not dunx's.
