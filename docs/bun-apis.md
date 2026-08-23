> ## Documentation Index
>
> Fetch the complete documentation index at: https://bun.com/docs/llms.txt
> Use this file to discover all available pages before exploring further.

# Bun APIs

> Overview of Bun's native APIs available on the Bun global object and built-in modules

Bun implements a set of native APIs on the `Bun` global object and through several built-in modules. These APIs are heavily optimized and are the canonical "Bun-native" way to implement common functionality.

Bun strives to implement standard Web APIs wherever possible. Bun introduces new APIs primarily for server-side tasks where no standard exists, such as file I/O and starting an HTTP server. In these cases, Bun's approach still builds atop standard APIs like `Blob`, `URL`, and `Request`.

```ts server.ts icon="https://mintcdn.com/bun-1dd33a4e/JUhaF6Mf68z_zHyy/icons/typescript.svg?fit=max&auto=format&n=JUhaF6Mf68z_zHyy&q=85&s=7ac549adaea8d5487d8fbd58cc3ea35b" theme={"theme":{"light":"github-light","dark":"dracula"}}
Bun.serve({
  fetch(req: Request) {
    return new Response('Success!');
  },
});
```

Use the links in the table to jump to the associated documentation.

| Topic                            | APIs                                                                                                                                                                                                                                                                                                                                       |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| HTTP Server                      | [`Bun.serve`](/docs/runtime/http/server)                                                                                                                                                                                                                                                                                                   |
| Shell                            | [`$`](/docs/runtime/shell)                                                                                                                                                                                                                                                                                                                 |
| Bundler                          | [`Bun.build`](/docs/bundler)                                                                                                                                                                                                                                                                                                               |
| File I/O                         | [`Bun.file`](/docs/runtime/file-io#reading-files-bun-file), [`Bun.write`](/docs/runtime/file-io#writing-files-bun-write), `Bun.stdin`, `Bun.stdout`, `Bun.stderr`                                                                                                                                                                          |
| Child Processes                  | [`Bun.spawn`](/docs/runtime/child-process#spawn-a-process-bun-spawn), [`Bun.spawnSync`](/docs/runtime/child-process#blocking-api-bun-spawnsync)                                                                                                                                                                                            |
| TCP Sockets                      | [`Bun.listen`](/docs/runtime/networking/tcp#start-a-server-bun-listen), [`Bun.connect`](/docs/runtime/networking/tcp#start-a-server-bun-listen)                                                                                                                                                                                            |
| UDP Sockets                      | [`Bun.udpSocket`](/docs/runtime/networking/udp)                                                                                                                                                                                                                                                                                            |
| WebSockets                       | `new WebSocket()` (client), [`Bun.serve`](/docs/runtime/http/websockets) (server)                                                                                                                                                                                                                                                          |
| Transpiler                       | [`Bun.Transpiler`](/docs/runtime/transpiler)                                                                                                                                                                                                                                                                                               |
| Routing                          | [`Bun.FileSystemRouter`](/docs/runtime/file-system-router)                                                                                                                                                                                                                                                                                 |
| Streaming HTML                   | [`HTMLRewriter`](/docs/runtime/html-rewriter)                                                                                                                                                                                                                                                                                              |
| Headless Browser                 | [`Bun.WebView`](/docs/runtime/webview)                                                                                                                                                                                                                                                                                                     |
| Hashing                          | [`Bun.password`](/docs/runtime/hashing#bun-password), [`Bun.hash`](/docs/runtime/hashing#bun-hash), [`Bun.CryptoHasher`](/docs/runtime/hashing#bun-cryptohasher), `Bun.sha`                                                                                                                                                                |
| CSRF Protection                  | [`Bun.CSRF.generate`](/docs/runtime/csrf), [`Bun.CSRF.verify`](/docs/runtime/csrf)                                                                                                                                                                                                                                                         |
| SQLite                           | [`bun:sqlite`](/docs/runtime/sqlite)                                                                                                                                                                                                                                                                                                       |
| SQL Client                       | [`Bun.SQL`](/docs/runtime/sql), `Bun.sql`                                                                                                                                                                                                                                                                                                  |
| Redis (Valkey) Client            | [`Bun.RedisClient`](/docs/runtime/redis), `Bun.redis`                                                                                                                                                                                                                                                                                      |
| FFI (Foreign Function Interface) | [`bun:ffi`](/docs/runtime/ffi)                                                                                                                                                                                                                                                                                                             |
| DNS                              | [`Bun.dns.lookup`](/docs/runtime/networking/dns), `Bun.dns.prefetch`, `Bun.dns.getCacheStats`                                                                                                                                                                                                                                              |
| Testing                          | [`bun:test`](/docs/test)                                                                                                                                                                                                                                                                                                                   |
| Workers                          | [`new Worker()`](/docs/runtime/workers)                                                                                                                                                                                                                                                                                                    |
| Module Loaders                   | [`Bun.plugin`](/docs/bundler/plugins)                                                                                                                                                                                                                                                                                                      |
| Glob                             | [`Bun.Glob`](/docs/runtime/glob)                                                                                                                                                                                                                                                                                                           |
| Cookies                          | [`Bun.Cookie`](/docs/runtime/cookies), [`Bun.CookieMap`](/docs/runtime/cookies)                                                                                                                                                                                                                                                            |
| Node-API                         | [`Node-API`](/docs/runtime/node-api)                                                                                                                                                                                                                                                                                                       |
| `import.meta`                    | [`import.meta`](/docs/runtime/module-resolution#import-meta)                                                                                                                                                                                                                                                                               |
| Utilities                        | [`Bun.version`](/docs/runtime/utils#bun-version), [`Bun.revision`](/docs/runtime/utils#bun-revision), [`Bun.env`](/docs/runtime/utils#bun-env), [`Bun.main`](/docs/runtime/utils#bun-main)                                                                                                                                                 |
| Sleep & Timing                   | [`Bun.sleep()`](/docs/runtime/utils#bun-sleep), [`Bun.sleepSync()`](/docs/runtime/utils#bun-sleepsync), [`Bun.nanoseconds()`](/docs/runtime/utils#bun-nanoseconds)                                                                                                                                                                         |
| Random & UUID                    | [`Bun.randomUUIDv7()`](/docs/runtime/utils#bun-randomuuidv7)                                                                                                                                                                                                                                                                               |
| System & Environment             | [`Bun.which()`](/docs/runtime/utils#bun-which)                                                                                                                                                                                                                                                                                             |
| Comparison & Inspection          | [`Bun.peek()`](/docs/runtime/utils#bun-peek), [`Bun.deepEquals()`](/docs/runtime/utils#bun-deepequals), `Bun.deepMatch`, [`Bun.inspect()`](/docs/runtime/utils#bun-inspect)                                                                                                                                                                |
| String & Text Processing         | [`Bun.escapeHTML()`](/docs/runtime/utils#bun-escapehtml), [`Bun.stringWidth()`](/docs/runtime/utils#bun-stringwidth), `Bun.indexOfLine`                                                                                                                                                                                                    |
| URL & Path Utilities             | [`Bun.fileURLToPath()`](/docs/runtime/utils#bun-fileurltopath), [`Bun.pathToFileURL()`](/docs/runtime/utils#bun-pathtofileurl)                                                                                                                                                                                                             |
| Compression                      | [`Bun.gzipSync()`](/docs/runtime/utils#bun-gzipsync), [`Bun.gunzipSync()`](/docs/runtime/utils#bun-gunzipsync), [`Bun.deflateSync()`](/docs/runtime/utils#bun-deflatesync), [`Bun.inflateSync()`](/docs/runtime/utils#bun-inflatesync), `Bun.zstdCompressSync()`, `Bun.zstdDecompressSync()`, `Bun.zstdCompress()`, `Bun.zstdDecompress()` |
| Stream Processing                | [`Bun.readableStreamTo*()`](/docs/runtime/utils#bun-readablestreamto), `Bun.readableStreamToBytes()`, `Bun.readableStreamToBlob()`, `Bun.readableStreamToFormData()`, `Bun.readableStreamToJSON()`, `Bun.readableStreamToArray()`                                                                                                          |
| Memory & Buffer Management       | `Bun.ArrayBufferSink`, `Bun.allocUnsafe`, `Bun.concatArrayBuffers`                                                                                                                                                                                                                                                                         |
| Module Resolution                | [`Bun.resolveSync()`](/docs/runtime/utils#bun-resolvesync)                                                                                                                                                                                                                                                                                 |
| Parsing & Formatting             | [`Bun.semver`](/docs/runtime/semver), [`Bun.TOML.parse`](/docs/runtime/toml), [`Bun.markdown`](/docs/runtime/markdown), [`Bun.color`](/docs/runtime/color), [`Bun.Image`](/docs/runtime/image)                                                                                                                                             |
| Low-level / Internals            | `Bun.mmap`, `Bun.gc`, `Bun.generateHeapSnapshot`, [`bun:jsc`](https://bun.com/reference/bun/jsc)                                                                                                                                                                                                                                           |

## Re-probed on Bun 1.4.0 (rev 34cbb9a40)

Everything below this heading was first measured on 1.3.14. Re-running the probes on
1.4 moved five entries and added three; the rest still reproduce. **Fixed** means the
probe that used to fail now passes, not that the note was wrong.

| Finding                                                           | On 1.4                                                            |
| ----------------------------------------------------------------- | ----------------------------------------------------------------- |
| `Bun.color(hex, 'ansi')` emits a raw newline at index 10          | **fixed** - `FORCE_COLOR=1` gives `\u001b[92m`, an SGR-16 code    |
| `AsyncLocalStorage.enterWith()` segfaults after any `await`       | **fixed** - and still not worth adopting, see below               |
| `Bun.SQL`'s SQLite adapter silently stores `NULL` for a `Date`    | **fixed** - rejects, matching `bun:sqlite`                        |
| A connect that never completes outlives `close()`                 | **fixed** - exits one `connectionTimeout` after the attempt       |
| `Bun.cron`'s `{ tz }` is silently ignored, and undeclared         | **honoured**, declared as `Bun.CronOptions`, default zone flipped |
| A server-side Redis error arrives as `ERR_REDIS_INVALID_RESPONSE` | **renamed** to `ERR_REDIS_SERVER_ERROR`                           |
| `Bun.write(path, stream)` writes `[object ReadableStream]`        | reproduces                                                        |
| `Bun.write(path, new Response(stream))` never settles             | reproduces                                                        |
| `Bun.file(path).writer()` does not truncate                       | reproduces                                                        |
| `bun:sqlite`'s `db.transaction()` cannot roll back an async body  | reproduces                                                        |
| `prepare()` compiles one statement and drops the rest             | reproduces                                                        |
| `Bun.SQL.prototype` is `undefined`, `instanceof` throws           | reproduces                                                        |
| Subscriber mode leaks past `close()` without `unsubscribe()`      | reproduces                                                        |
| A failed `subscribe()` leaks past `close()`                       | reproduces                                                        |

The whole 1.4 API surface the release notes claim is present and reachable: `Bun.Image`,
`Bun.WebView`, `Bun.markdown` (`html`, `ansi`, `render`, `react`), `Bun.cron`,
`Bun.Terminal`, `Bun.JSON5`, `Bun.JSONL`, `Bun.JSONC`, `Bun.XML`, `Bun.TOML.stringify`,
`Bun.Archive`, `Bun.sliceAnsi`, `Bun.wrapAnsi`, plus `CompressionStream`,
`DecompressionStream`, `URLPattern` and `Response.prototype.textStream` as globals.
`Bun.JSONC` has `parse` only, and `Bun.Archive` has `write` only.

### Verified on this machine - Bun 1.3.14

Probed rather than assumed, because the table above is not exhaustive and a few
entries in it are wrong about what is reachable. Extend this section whenever you
verify something; do not delete a line without re-probing it.

```
bun -e "console.log(Object.getOwnPropertyNames(Bun.Image.prototype))"
```

### Present and undocumented

| API                 | Notes                                                            |
| ------------------- | ---------------------------------------------------------------- |
| `Bun.S3Client`      | Absent from the table above. Native S3 - no `@aws-sdk/*` needed. |
| `Bun.embeddedFiles` | Files embedded by `bun build --compile`.                         |
| `Bun.openInEditor`  | Opens a path in the user's editor.                               |
| `Bun.mmap`          | Listed above only as "low-level"; it is a plain function.        |

### `Bun.Image` surface

Barely documented upstream, so the member list matters:

- **statics** - `backend`, `fromClipboard`, `hasClipboardImage`, `clipboardChangeCount`
- **metadata / dimensions** - `metadata()`, `width`, `height`
- **transforms** - `resize`, `rotate`, `flip`, `flop`, `modulate`
- **encoders** - `png`, `jpeg`, `webp`, `avif`, `heic`
- **outputs** - `blob`, `buffer`, `bytes`, `dataurl`, `toBase64`, `toBuffer`, `write`
- **other** - `placeholder`

Construction is `new Bun.Image(source)`. A real-world use is reading dimensions off
an upload buffer with `await new Bun.Image(buffer).metadata()`, which replaces an
`image-size` dependency outright.

### Confirmed reachable

`Bun.serve`, `Bun.SQL`, `Bun.sql`, `Bun.RedisClient`, `Bun.redis`, `Bun.Image`,
`Bun.Glob`, `Bun.file`, `Bun.write`, `Bun.password`, `Bun.CryptoHasher`,
`Bun.zstdCompressSync`, `Bun.CookieMap`, `Bun.udpSocket`, `Bun.listen`,
`Bun.connect`, `Bun.FileSystemRouter`, `Bun.ArrayBufferSink`, `Bun.randomUUIDv7`,
`Bun.inflateSync`, `Bun.Transpiler`, `Bun.color`, `Bun.semver`, `Bun.markdown`,
`Bun.TOML`, `Bun.which`, `Bun.hash`, `Bun.CSRF`, `Bun.dns`, `Bun.stringWidth`,
`Bun.escapeHTML`, `Bun.deepEquals`, `Bun.peek`, `Bun.readableStreamToBytes`,
`Bun.build`.

Modules: `bun:sqlite` (exports `Database`, `Statement`, `SQLiteError`, `constants`),
`bun:ffi`, `bun:jsc`, `bun:test`.

### Note on `Bun.SQL` and `Bun.RedisClient`

Both report `.length === 0`, so constructor arity tells you nothing about their
options - read the runtime, not the signature.

### `Bun.RedisClient` - quirks found by probing

`Bun.RedisClient.prototype` carries 213 methods on 1.4.0, and an instance has **no own
properties at all**. Most of the prototype works. These do not behave as documented,
and each cost real debugging time. Everything in this table still reproduces on 1.4
unless the row says otherwise:

| Behaviour                                              | Detail                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `psubscribe` is unusable                               | Present on the prototype, absent from `bun-types`. With a listener it throws `ERR_INVALID_ARG_TYPE`; with a pattern alone it now resolves in under a millisecond, but the client exposes no hook for pattern messages (`onmessage`, `onpmessage` and `onMessage` are all `undefined`), so there is nowhere for a delivery to go. **Re-measured on Bun 1.3.14: the pattern-only promise does settle - an earlier note here said it hung a probe for 120s, which is no longer true.** Still unusable, for the missing listener rather than the hang.                                                                                                                                                                                                                                                                                                                                 |
| A server error's `code` changed name in 1.4            | An error Redis itself returned - `WRONGTYPE`, `ERR unknown command`, a wrong argument count - carries `ERR_REDIS_SERVER_ERROR` on 1.4 and carried `ERR_REDIS_INVALID_RESPONSE` on 1.3. The rename is the right way round, since the response parsed fine and the command did not. `@dunx/infra/redis` exports `isServerError()`, which spans both, because `@types/bun` is a `>=1.3.0` peer.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `exists()` is lossy                                    | Bun coerces Redis's integer reply to `boolean`, so `exists('a', 'missing')` returns `true`. Use `send('EXISTS', keys)` when you need the count.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Bad URLs are accepted                                  | `new Bun.RedisClient('not-a-url')` succeeds, then fails at connect as an opaque `Connection closed`. Validate URLs yourself.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `enableOfflineQueue: false` breaks lazy connect        | The first command is rejected with "offline queue is disabled" even against a healthy server unless you `connect()` first.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| A failed connection leaks a retry timer past `close()` | With `maxRetries > 0`, a client that never connects keeps an internal timer alive after `close()` and **the process never exits**. Measured: `maxRetries=1` hung until killed at 6s; `maxRetries=0` exited 0. Reproduced in plain Bun with no framework involved, so nothing in userland can clear it. Use `maxRetries: 0` or `autoReconnect: false` for a connection that may be absent.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Subscriber mode throws **synchronously**               | A client in subscriber mode rejects data commands with `ERR_REDIS_INVALID_STATE`, thrown synchronously - `.then(ok, err)` does not catch it. Subscriptions need their own connection.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Subscriber mode also leaks past `close()`              | Separate from the retry-timer leak above, and it happens with `maxRetries: 0` against a **healthy** server. A client that ever entered subscriber mode keeps the event loop alive after `close()`, so the process never exits. Measured: subscribe then `close()` hung until killed at 10s; publish-only on the same client exited 0. `await client.unsubscribe()` before `close()` fixes it - with a channel or with no arguments, both work. Any long-lived subscriber must leave subscriber mode on shutdown; `bun test` hides this, because the runner exits the process itself.                                                                                                                                                                                                                                                                                               |
| A **failed** `subscribe()` leaks past `close()` too    | The same hazard from the other end, and `maxRetries: 0` does not save you. `subscribe()` against a server that cannot be reached rejects with `Max reconnection attempts reached` and then holds the event loop open after `close()`; `unsubscribe()` cannot rescue it, because the client is not in subscriber mode and rejects with `can only be called while in subscriber mode`. A failed `publish()` on the same url releases cleanly, so it is specific to `subscribe()`. Fix: `await client.connect()` **before** `subscribe()`. Connect fails first, releases cleanly, and reports `Connection closed`.                                                                                                                                                                                                                                                                    |
| A connect that never completes leaks past `close()`    | **Fixed in Bun 1.4.0**, which exits 0 one `connectionTimeout` after the attempt. On 1.3.14: a third member of the same family, and the one with **no workaround at all**. Against an address that neither accepts nor refuses the connection (a dropped SYN - `10.255.255.1:6379`), one `send()` rejects on `connectionTimeout` and the process then never exits. Unmoved by `maxRetries: 0`, `autoReconnect: false`, `enableOfflineQueue: false` (which rejects in 10 ms without waiting and hangs anyway, so it is the socket and not the command queue), a shorter `connectionTimeout`, closing twice, closing while the connect is still pending, or waiting six seconds after `close()`. A **refused** connection is clean, and so is construct-and-close with no attempt, so the handle is the pending connect itself. See internal/notes/roadmap/queue-shutdown-sigterm.md. |
| There is no `url` property                             | `new Bun.RedisClient(url).url` is `undefined`, and the instance has no own properties at all. Anything that reconstructs a client from one it was handed - bullmq's Bun adapter does, for a worker's blocking `duplicate()` and for every reconnect - silently falls back to Bun's default url resolution and connects to a **different server**. Measured and worked around in `@dunx/infra/queue`, which hands bullmq a `Bun.RedisClient` subclass carrying the url.                                                                                                                                                                                                                                                                                                                                                                                                             |

#### The SIGTERM hang is two leaks, and only one of them is bullmq's

Measured while wiring `@dunx/infra/queue`, then **re-bisected a layer at a time and
re-attributed**. The earlier entry here blamed bullmq for all of it; that was half
wrong. Same process each time - construct, attempt one operation, tear down, then
`SIGTERM` and wait 12 s, with `connectionTimeout: 2000, maxRetries: 0` throughout:

| server                          | plain `Bun.RedisClient` | `createBunRedisClient` over it | a bullmq `Queue` on it |
| ------------------------------- | ----------------------- | ------------------------------ | ---------------------- |
| healthy `127.0.0.1:6379`        | exits 0 in ~100 ms      | exits 0 in ~100 ms             | exits 0 in ~110 ms     |
| refused `127.0.0.1:6399`        | exits 0 in ~100 ms      | **never exits**                | **never exits**        |
| black-holed `10.255.255.1:6379` | **never exits**         | **never exits**                | **never exits**        |

The black-holed row is Bun's, and is the "connect that never completes" entry in the
table above - no framework involved. The refused row is bullmq's: its adapter runs a
`setTimeout` reconnect chain, and both `disconnect()` and `quit()` return early when
`closed` is already `true`, which is exactly when a reconnect is pending. Nothing on
`IRedisClient` can cancel it. Reproductions for both, ready to file, are in
internal/notes/roadmap/queue-shutdown-sigterm.md.

The healthy row is clean at every layer, which is why no normal deployment sees this.
Consequence: a container that touched a Redis it could not reach will not exit on
`SIGTERM` and will be `SIGKILL`ed. It serves correctly throughout - the route answers
503 in single-digit milliseconds - so this is a shutdown defect, not an availability
one.

Two neighbouring leaks in `Bun.RedisClient` itself, both fixed in
`@dunx/infra/redis`: a client that entered subscriber mode needs `unsubscribe()`
before `close()`, and a `subscribe()` that failed to connect needs `connect()` first.
`bun test` cannot observe either, because the runner exits the process itself - they
need a spawned process to catch, which is what `@dunx/infra/redis` now has.

**bullmq 6.0.5 has no `exports` map and no `"type": "module"`, so Bun resolves it to
`main` - the CJS build.** The imported namespace carries `__esModule` and a `default`
holding `Queue`, which is how you tell. This matters because a previous note here
claimed the ESM build was the safe one: both builds statically import `ioredis` and
`ioredis/built/utils`, ioredis 6.0.0 still ships that path, and no pin is needed.
Full measurement in architecture/queues.md, "Not pinning ioredis 5".

Real but missing from `bun-types`: `psubscribe`, `punsubscribe`, `pubsub`, `script`,
`select`, `connected`, `bufferedAmount`, `onclose`, `onconnect`. Of these `pubsub`,
`script` and `select` work and are reachable through `send()`.

### `req.json()` is the cost of a validated request, and there is no native alternative

Measured on `internal/bench`'s validation harness (`bun run validation`), four raw
`Bun.serve` routes answering identical bytes, one adding one step to the last:

| Step                                     | µs/req | adds     |
| ---------------------------------------- | -----: | -------- |
| `GET`, no request body                   |   8.78 | -        |
| `POST`, body on the wire, **never read** |   9.05 | +0.27 µs |
| `POST` + `await req.json()`              |  12.14 | +3.10 µs |
| `POST` + `req.json()` + zod              |  13.09 | +0.94 µs |

**Putting a body on the wire is near-free; reading it is not, and reading it costs
~3.3x what validating it costs.** So the framework-level advice - "pick a faster
validator" - is aimed at the smaller half. Every validator measured (zod, Valibot,
ArkType, TypeBox's compiled checker, ajv) lands between 0.0 µs and 0.94 µs, all of
them under the parse.

**The primitive Bun is missing is a validating parser.** `req.json()` allocates a
full JavaScript object graph which the validator then walks a second time, and
Bun ships nothing that fuses the two: no `Bun.JSON` with a schema, no JSON Schema
validator, no way to validate the body bytes without materialising them first.
`Bun.TOML` and `Bun.markdown` exist; a `Bun.json(bytes, schema)` that answered from
one pass over the buffer would remove most of what a validated POST costs today, and
it is the kind of thing only the runtime can do - a userland library cannot avoid
the intermediate object.

Until then this is a floor, not a dunx cost, and **dunx must not try to fill it**:
Not inventing what a mature library solves rules out writing a validator, and a
hand-rolled JSON parser
would be a JavaScript reimplementation of a JSC primitive, which the first half
rules out. Recorded here so the ceiling is known rather than rediscovered.

### `Bun.cron` - 1.4 honours `{ tz }` and changed the default zone

Two changes in one release, and the second is the one that moves a running schedule.

| Behaviour                               | 1.3.14               | 1.4.0                                    |
| --------------------------------------- | -------------------- | ---------------------------------------- |
| `{ tz }` on `cron()` and `cron.parse()` | accepted and ignored | honoured                                 |
| Declared in `bun-types`                 | no                   | yes, as `Bun.CronOptions`                |
| An unknown zone id                      | silently ignored     | throws `Bun.cron: unknown time zone 'x'` |
| The default zone with no `tz`           | UTC                  | **the container's local zone**           |

Measured for `'0 12 * * *'` relative to `2026-01-15T00:00:00Z`:

```
tz: 'UTC'           -> 2026-01-15T12:00:00.000Z
tz: 'Asia/Kolkata'  -> 2026-01-15T06:30:00.000Z    (UTC+05:30, honoured)
no tz               -> 2026-01-15T10:00:00.000Z    (machine is UTC+02:00)
```

**The default flip is a silent behaviour change for any caller that omitted `tz`.** A
nightly job written as `'0 3 * * *'` fired at 03:00 UTC on 1.3 and fires at 03:00
local on 1.4, so a container with `TZ` set moves it. `@dunx/infra/schedule` passes
`tz` on every call and defaults it to `'UTC'`, so no dunx schedule moves; a direct
`Bun.cron` caller has to pass it.

Consequence for the code: `packages/infra/src/schedule/bun-cron.ts` existed only to
cast around the missing declaration and said "delete this file when bun-types declares
the option". It is deleted; the call sites use `Bun.cron` and `Bun.cron.parse`
directly. `supportsTz()` stays, because the probe is what tells a 1.3 runtime from a
1.4 one without reading `Bun.version`.

### `Bun.serve` directory routes - `{ dir }`, new in 1.4

`{ dir: './public' }` as a route value serves a directory natively. What it does is
more than the docs claim and less than a static-file middleware needs, so both halves
matter before adopting it. Probed against a wildcard route (`'/assets/*'`):

| Behaviour                       | Result                                  |
| ------------------------------- | --------------------------------------- |
| `Content-Type` from extension   | yes, with `charset=utf-8`               |
| Weak `ETag`, `Last-Modified`    | yes, both                               |
| `If-None-Match`                 | 304                                     |
| `If-Modified-Since`             | 304                                     |
| `Range`                         | 206, and `accept-ranges: bytes`         |
| Directory with a trailing slash | serves `index.html`                     |
| Directory without one           | 301 to the trailing-slash URL           |
| Missing file                    | 404                                     |
| `..`, `%2e%2e%2f`, `..%2F`      | 404 on all three - traversal is handled |

Three things it does not do, and the first is the one that decides an adoption:

| Gap                                           | Detail                                                                                                                                                                                                            |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **No `cache-control`, and no way to set one** | `DirectoryRouteOptions` is `{ dir, statCache }` and nothing else. A `headers` key is accepted and **silently ignored**. Since Bun answers the route itself, a dunx middleware never sees the response to add one. |
| **Every HTTP method is served**               | `GET`, `HEAD`, `POST`, `PUT`, `DELETE`, `PATCH` and `OPTIONS` all return **200 with the file body**. So `DELETE /assets/app.js` answers with the script, and `OPTIONS` cannot carry CORS preflight headers.       |
| No `x-content-type-options: nosniff`          | Not set, and not settable for the same reason as `cache-control`.                                                                                                                                                 |

One more shape worth knowing: `index` is **half-implemented**. It is type-checked at
`Bun.serve` (`index: false` throws `The "index" property must be of type string`),
undeclared in `bun-types`, and then ignored - `{ dir, index: 'a.txt' }` still serves
`index.html`. A validated-but-inert option is worse than an unknown one, which Bun
would merely drop.

`@dunx/http`'s `StaticFiles` exists for the cache policy, so `{ dir }` does not
replace it as it stands. The two gaps above are what a swap is waiting on.

### OpenTelemetry on 1.4 - `require` only, and it never sees `Bun.serve`

The 1.4 notes say OTel's http and fs instrumentation export spans, with shimmer and
require-in-the-middle patching bundled code. Probed with `@opentelemetry/sdk-node`
(73 packages), `instrumentation-http` and an `InMemorySpanExporter`, everything under
`bun --preload`:

| Entry path                                   | Spans                                         |
| -------------------------------------------- | --------------------------------------------- |
| `require('node:http')` server and `http.get` | 2 - a server span and a client span           |
| `import('node:http')`, identical requests    | none, and `http.get.__wrapped` is `undefined` |
| `Bun.serve` inbound                          | none                                          |
| global `fetch` outbound                      | none                                          |

`require-in-the-middle` hooks `require`, and an ESM import of a `node:` builtin does
not go through it, so a preloaded SDK patches nothing unless the file that imports
`node:http` is CJS. The same process instruments a CJS `require` and misses the ESM
import beside it.

The API half works. `startActiveSpan` holds context across an `await`, and a child
started after it carries the parent's trace id and span id -
`@opentelemetry/context-async-hooks` over `AsyncLocalStorage`.

For dunx none of it arrives for free. Requests come in on `Bun.serve`, go out through
`fetch`, reach Redis through `Bun.RedisClient` and Postgres through `Bun.SQL`. The
auto-instrumentation sees none of those four. Tracing here would be spans dunx emits
against `@opentelemetry/api` at the seams it already owns: the request middleware, the
job processor, the Redis wrapper.

### `Bun.deflateSync` and `CompressionStream('deflate')` disagree on the format

`Content-Encoding: deflate` means zlib (RFC 1950). Bun's two encoders produce
different bytes for it, and only one of them is that:

| Encoder                            | First bytes | Format      |
| ---------------------------------- | ----------- | ----------- |
| `Bun.deflateSync(data)`            | `cb 48`     | raw DEFLATE |
| `new CompressionStream('deflate')` | `78 9c`     | zlib        |
| `node:zlib`'s `deflateSync`        | `78 9c`     | zlib        |

`DecompressionStream('deflate')` decodes the stream output and throws
`inflate failed` on the sync one. Nothing reconciles them: `{ library: 'zlib' }`,
`{ windowBits: 15 }`, `{ windowBits: -15 }` and `{ level: 6 }` all leave
`deflateSync` raw.

`@dunx/http`'s `Compression` therefore offers `zstd` and `gzip` only. It picks the
sync encoder for a body it can buffer and `CompressionStream` for one it cannot, so
offering `deflate` would have changed the wire format at the buffering threshold
and served bytes a strict client rejects. `gzip` is accepted by everything that
would have taken `deflate`.

`Bun.gzipSync` and `CompressionStream('gzip')` agree, and so do the two zstd
encoders; this is `deflate` alone.

### `Bun.serve({ websocket })` and `ServerWebSocket`

- **`ServerWebSocket`**: `send`, `sendText`, `sendBinary`, `publish`, `publishText`,
  `publishBinary`, `subscribe`, `unsubscribe`, `isSubscribed`, `subscriptions`,
  `cork`, `ping`, `pong`, `close`, `terminate`, `getBufferedAmount`, `data`,
  `readyState`, `remoteAddress`, `binaryType`.
- **`Server`**: `upgrade(req, { data, headers })`, `publish`, `subscriberCount`,
  `pendingWebSockets`, `stop(force?)`, `url`, `requestIP`, `closeIdleConnections`,
  `reload`.
- **`websocket` options**: `message` (required), `open`, `close`, `drain`, `ping`,
  `pong`, `data`, `idleTimeout`, `maxPayloadLength`, `backpressureLimit`,
  `closeOnBackpressureLimit`, `perMessageDeflate`, `publishToSelf`, `sendPings`.

Quirks:

| Behaviour                                     | Detail                                                                                                                 |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Unknown `websocket` keys are silently ignored | A typo'd option is a no-op, not an error. Derive your option type from Bun's with `Pick` so it cannot drift.           |
| `idleTimeout` above 960 throws                | Rejected at `Bun.serve`, not clamped.                                                                                  |
| Graceful `stop()` hangs with a live WebSocket | `server.stop()` never resolves while a socket is open; `stop(true)` is required, and clients then see close code 1006. |
| Close `reason` arrives empty                  | Once frames have been exchanged, `close()` receives an empty `reason`. The code is reliable; the reason is not.        |
| No way to enumerate server sockets            | So a graceful per-socket close before shutdown is not possible.                                                        |
| Bun's _client_ `WebSocket` is non-standard    | It has extra `ping`/`pong`/`terminate` methods.                                                                        |

Native pub/sub (`socket.subscribe(topic)` / `server.publish(topic, data)`) is real and
should be used instead of a JavaScript topic registry.

### `Bun.file` / `Bun.write` - three data-loss traps

All three reproduced independently, not just reported:

All three still reproduce on Bun 1.4.0.

| Behaviour                                                             | Detail                                                                                                                                |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `Bun.write(path, readableStream)` **silently writes the wrong bytes** | It matches no overload, so the stream is stringified: the file contains the 23 bytes `[object ReadableStream]`. No error, no warning. |
| `Bun.write(path, new Response(stream))` **never settles**             | Hangs forever when the `Response` body is a stream. `new Response('string')` settles normally.                                        |
| `Bun.file(path).writer()` **does not truncate**                       | Writing `"bb"` over a 20-byte file leaves `bbAAAAAAAAAAAAAAAAAA`. It also does not create parent directories.                         |

Measured:

```
1) write(stream)            -> "[object ReadableStream]" (23 bytes)
3) writer() truncate        -> "bbAAAAAAAAAAAAAAAAAA" (20 bytes)
2) write(Response(stream))  -> NEVER SETTLED (2.5s timeout)
   control Response("plain") -> settled
```

A streaming write therefore has to go through a sink (`FileSink` locally,
`NetworkSink` for S3), preceded by an empty `Bun.write` to create parents and
truncate.

### `Bun.S3Client` - the undocumented surface

`prototype`: `delete`, `exists`, `file`, `list`, `presign`, `size`, `stat`,
`unlink`, `write`. Each also exists as a **static**, taking credentials per call.

`client.file(key)` returns an **`S3File extends Blob`** adding `arrayBuffer`,
`bytes`, `delete`, `exists`, `formData`, `image`, `json`, `lastModified`, `name`,
`size`, `slice`, `stat`, `stream`, `text`, `type`, `unlink`, `write`, `writer`,
`presign`, `bucket`.

- `presign()` is **synchronous and offline** - HMAC over the canonical request.
- `stat()` → `{ size, lastModified: Date, etag, type }`, not an fs `Stats`.
- `write()` accepts string / ArrayBufferView / ArrayBuffer / Request / Response /
  BunFile / S3File / Blob / File / Archive - **not** `ReadableStream`. Use
  `file().writer()`, which returns a multipart `NetworkSink`.

### `Bun.Image` - behaviour that will surprise you

Fully typed in `bun-types` (`bun.d.ts` ~8180-8408), just undocumented on the site.

- **Lazy and re-runnable.** Chainables only record; the pipeline runs on a worker
  when a terminal is awaited. A second terminal on the same instance re-runs it.
- **Chainables mutate and return `this`, not a clone - and overwrite.**
  `.resize(10,10).resize(20,20)` yields 20×20. Execution order is fixed at
  `autoOrient → rotate → flip/flop → resize → modulate` regardless of call order.
  A shared instance therefore lets one caller silently reconfigure another's
  transform, which is why a wrapper should be immutable.
- **`metadata()` ignores the chain** and only reads the header, so it reports the
  _source_ dimensions and format. It also succeeds on a truncated file - it is
  **not** a validity check.
- **`width`/`height` are `-1`** until a terminal has been awaited, then hold
  whatever that terminal produced.
- **Decode-only formats do not round-trip.** The types claim a terminal with no
  format setter re-encodes in the source format; for `gif`/`bmp`/`tiff` it actually
  emits **PNG**.
- **`placeholder()` also ignores the chain** - always a ThumbHash of the source.
- Silent clamping, no throw: `resize(0)`, `resize(-5)`, `resize(1.5)` → 1×1;
  `quality` outside 0-100 is clamped. Unknown option _keys_ are ignored, unknown
  `filter` _values_ throw.
- Errors are plain `Error` + `error.code` (`ERR_IMAGE_UNKNOWN_FORMAT`,
  `ERR_IMAGE_DECODE_FAILED`, `ERR_IMAGE_FORMAT_UNSUPPORTED`,
  `ERR_IMAGE_TOO_MANY_PIXELS`), except argument validation which is `TypeError`.
- **Undocumented but present:** `Bun.file(p).image()` and `Blob.prototype.image()`;
  a `data:` URL is accepted as input; `linear` is a valid resize filter despite
  being absent from the error message listing valid names. An `http(s)://` string
  is **not** fetched - it is treated as a path.
- On Linux `backend` is `'bun'`, HEIC/AVIF **encode** is unsupported, `tiff` decode
  fails, and the clipboard statics are inert.

### `Bun.SQL` and `bun:sqlite`

- **`Bun.SQL.prototype` is `undefined`.** It is a native constructor whose instances
  are callable functions; `unsafe`, `begin`, `close`, `connect`, `options`,
  `reserve` are own properties of the _instance_. Probing the prototype throws.
- Supported adapters are exactly `postgres`, `sqlite`, `mysql`, `mariadb`. **`pg://`
  is not supported**; `postgresql://`, `file:` and `sqlite://` are.
- A **schemeless** URL is silently treated as a Postgres _host_: `{ url: './dev.db' }`
  reports `adapter: 'postgres'` and fails much later with a socket error.
- Result metadata hangs off the returned array, and `affectedRows` **exists in the
  type but is `null`** on the SQLite adapter - `count` carries the real number.
- The SQLite adapter does not support `reserve()`.
- **`bun:sqlite`'s `db.transaction()` cannot roll back an async callback.** It
  commits when the function returns its promise, so awaited work is already
  committed and a later throw changes nothing. Issue `BEGIN`/`COMMIT`/`ROLLBACK`
  yourself for async work.
- `Statement.all/get/run/values/iterate` are own properties of the instance, not on
  `Statement.prototype`.
- **`{ create: false }` throws on a missing file from 1.4, and created one on 1.3.**
  1.4 raises `bad parameter or other API misuse`; 1.3.14 created the file, making the
  option inert. `{ readonly: true }` refuses on both, with `unable to open database
file`, so it is the portable way to require an existing database.
- **`prepare()` compiles one statement and silently drops the rest.** A multi-statement
  string - four `CREATE TABLE`s separated by semicolons - creates the first table only,
  with no error. That reaches through drizzle: `db.run(sql\`…\`)`goes via`prepare`, so
a DDL block has to be one statement per call. `db.exec()`/ the raw handle's`exec()`
  is the one that takes several.
- **A raw `Date` binding fails, and on 1.4 both adapters fail the same way.**

  ```
                    1.3.14                         1.4.0
  Bun.SQL sqlite    ACCEPTED, stored: null         REJECTED: Binding expected string, ...
  bun:sqlite        REJECTED: Binding expected ... REJECTED: Binding expected string, ...
  ```

  The 1.3 behaviour was the dangerous one: a timestamp column quietly lost every row
  with no error and no strict switch. 1.4 rejects instead, which turns a silent data
  loss into a thrown error. Convert to ISO 8601 for SQLite either way; Postgres takes
  a native binding. **An app that shipped against 1.3 and relied on the silence now
  throws** - that is a fix, but it is a behaviour change on upgrade.

- **`Bun.SQL` cannot be used with `instanceof`.** `s instanceof Bun.SQL` throws
  `TypeError: instanceof called on an object with an invalid prototype property`,
  which follows from `prototype` being `undefined` above. Narrow on
  `options.adapter`, or hold the client on a class you own.

#### `AsyncLocalStorage.enterWith()` works on 1.4, and is still the wrong call

On 1.3.14 three lines were enough to crash the process:

```ts
import { AsyncLocalStorage } from 'node:async_hooks';
const als = new AsyncLocalStorage<number>();
als.enterWith(1);
await Promise.resolve(); // 1.3.14: panic(main thread): Segmentation fault
```

**Bun 1.4 runs that and reads back `1`.** The note here used to say a working
`enterWith` would be worth adopting, "against a measured `run()` cost of +0.91 us".
Re-measured now that it works, over 200,000 iterations of the shape a request-logging
middleware would use - enter a scope carrying five fields, await, read one back:

| form                              | per scope |
| --------------------------------- | --------- |
| `run(fresh, async cb)`            | 0.168 us  |
| `enterWith(fresh)` then the await | 0.151 us  |
| no store at all, the floor        | 0.097 us  |

**The saving is 0.017 us**, a fifth of what the store costs and about 2% of the
+0.91 us the earlier note was aiming at. That number was the whole case for the swap,
and it does not survive contact.

The semantics settle it independently: `enterWith` cannot restore the enclosing store
on the way out. An `enterWith` inside a scope leaves the outer scope reading the inner
value forever, where `run()` restores it. `RequestContext.runWithContext` is specified
to merge and not leak back out, so it cannot be built on `enterWith` at any price:

```
run():       outer -> nested run()       -> outer sees "outer"
run():       outer -> nested enterWith() -> outer sees "clobbered"
```

So `AsyncRequestContext` and `@arkv/logger` keep `run()`, now as a choice between two
working primitives rather than for lack of an alternative.

The prize the earlier note was aiming at is also gone independently. `bun run logging`
on 1.4 prices the whole `AsyncLocalStorage` scope in request logging at **+0.24 us**,
down from +0.91 us, inside that harness's own +/-0.5 us floor. **Do not reopen this on
the segfault being fixed; both measurements were taken after the fix.**

#### `POSTGRES_URL` in the environment silently overrides an explicit `url`

Measured on 1.3.14. In the **options-object** form only,
`new Bun.SQL({ url: 'mysql://…' })` becomes `adapter: 'postgres'` and dials the
Postgres URL from the environment, failing with a bare `Connection closed` that
names nothing. The explicit argument loses to the ambient variable.

| Variable set                | `new Bun.SQL({ url: mysqlUrl })`   |
| --------------------------- | ---------------------------------- |
| `POSTGRES_URL`              | **hijacked** → `adapter: postgres` |
| `PGURL`                     | **hijacked** → `adapter: postgres` |
| `TLS_POSTGRES_DATABASE_URL` | **hijacked** → `adapter: postgres` |
| `DATABASE_URL`              | ok → `adapter: mysql`              |
| `MYSQL_URL`                 | ok → `adapter: mysql`              |

Three forms are unaffected, all verified: `new Bun.SQL(urlString)`,
`new Bun.SQL(new URL(url))`, and `new Bun.SQL({ url, adapter: 'mysql' })`. Note
that `@dunx/infra/db`'s `SqlOptions` uses the options-object form - harmless there,
because that backend is Postgres by construction, but any non-Postgres backend
built on `Bun.SQL` must name its `adapter`.

#### An in-flight MySQL query does not hold the event loop open

Measured on 1.3.14, and the failure is silent. A script whose only pending work is
a `Bun.SQL` query on the **MySQL** adapter exits **with code 0, mid-query** - no
error, no unhandled rejection, no output after the last completed statement. The
loop drains because the query holds no reference on it.

A long-running server never sees this, because `Bun.serve` keeps a reference. A CLI,
a migration, a seeder or a one-shot script does. Holding a `setInterval` for the
duration of the work is the workaround; `examples/databases/src/main.ts` does
exactly that and says why. The Postgres adapter and `bun:sqlite` are unaffected.

#### drizzle over `Bun.SQL` for MySQL - verified working

There is no Bun-native drizzle MySQL driver: drizzle 0.45.2's Bun entrypoints are
`bun-sql` (Postgres - `bun-sql/driver.js` builds a `PgDialect` unconditionally, so a
MySQL URL through it emits `$1` placeholders and double-quoted identifiers) and
`bun-sqlite`. Its MySQL drivers are `mysql2` and `mysql-proxy`.

`drizzle-orm/mysql-proxy` over `Bun.SQL` works and keeps the split: drizzle owns the
dialect, Bun owns the socket, `mysql2` is never installed. Verified against MySQL 8 inserts, selects, `where`, ordering, updates, deletes, aggregates,
`$returningId()` single and multi-row, inner and left joins, `placeholder()`
prepared statements, and the `mysql-proxy` migrator.

Three details the adapter has to get right, all found by running it:

- **`.values()` is mandatory for `method === 'all'`.** drizzle's `mapResultRow`
  indexes rows positionally, and `Bun.SQL`'s default object rows **lose columns on a
  join** - `users.id, users.name, posts.id, posts.name` returns two keys, not four,
  because the later names overwrite the earlier. A manual object→array conversion
  would be silently wrong.
- **`method === 'execute'` covers SELECTs too**, whenever the query carries no
  fields. Return the rows when the result array is non-empty, or `db.execute(sql…)`
  silently yields nothing.
- **`insertId`/`affectedRows` go in `rows[0]`**, not at the top level, despite
  `RemoteCallback`'s declared type - `mysql-proxy/session.js` reads
  `data[0].insertId`. Bun's own property is `lastInsertRowid`.

`mysql-proxy` refuses `db.transaction()` and `iterator()` outright. `Bun.SQL`'s
`begin()` reserves a connection, so a transaction is that plus a second drizzle
handle over the reserved socket. The whole adapter is
`examples/databases/src/mysql/driver.ts`.

### `Bun.color` - `'ansi'` is not a fixed encoding; the raw newline is fixed in 1.4

`Bun.color(hex, 'ansi')` returns whatever the _current terminal_ is judged to
support, not a stable format. That part is unchanged, and it is still why a log
formatter should name the encoding it wants.

On 1.3.14 the instability was also a corruption. Under `FORCE_COLOR=1` it degraded to
`ansi-16` and wrote the colour **index as a raw byte** rather than decimal digits;
index 10 is `\n`, so a coloured structured-log line silently became **two** records:

```
1.3.14  FORCE_COLOR=1  Bun.color('#00ff00', 'ansi')  -> "\u001b[38;5;\nm"   contains LF: true
1.4.0   FORCE_COLOR=1  Bun.color('#00ff00', 'ansi')  -> "\u001b[92m"        contains LF: false
        FORCE_COLOR=1  Bun.color('#00ff00', 'ansi-256') -> "\u001b[38;5;46m"
NO_COLOR=1             Bun.color('#00ff00', 'ansi')  -> ""   (Bun.enableANSIColors === false)
```

1.4 emits a well-formed SGR-16 code, so the data-loss half is gone. Asking for
**`'ansi-256'`** explicitly is still the advice, because it pins the encoding rather
than letting the terminal pick one - but it is now a determinism argument, not a
corruption one.

`Bun.enableANSIColors` is the honest capability check - it is `false` under
`NO_COLOR` and for a non-TTY, and it cannot be faked in-process, so testing
degradation needs a real subprocess with stdout piped.

### `setTimeout(...).unref()` - the semantics a forced exit depends on

Bun implements Node's timer `unref()`, and it behaves exactly as a graceful-shutdown
guard needs. Probed on Bun 1.3.14:

```
armed unref timer; nothing else holding the loop
exited naturally after 1ms                  <- callback never ran

UNREF FIRED after 503ms while server held the loop
exit=7                                      <- callback ran, process.exit took effect
```

Two properties, both load bearing for `ShutdownHooks`
(`packages/core/src/di/shutdown-hooks.ts`):

- An unref'd timer **cannot keep the process alive**. With nothing else pending the
  runtime exits at once and the callback is never invoked, so arming one costs a
  clean shutdown nothing at all.
- It still **fires on schedule when something else holds the loop open**, and
  `process.exit(code)` inside it takes effect.

That combination is what lets a shutdown hook say "end the process, but only if it
was not going to end anyway" without a race or a fixed delay. A ref'd timer would
add its own delay to every clean exit, and polling would need a loop that is itself
a handle.

### Decorators - a compound assignment to a private field is a `SyntaxError`

**Bun 1.4.0 refuses to parse a class that has both a decorated member and a
read-modify-write on a private field.** The whole file fails, at load, before
anything runs:

```
this.#n += 1   in a decorated class   SyntaxError: Left side of assignment is not a reference.
this.#n++      in a decorated class   SyntaxError: Postfix ++ operator applied to value that is not a reference.
this.#n ??= 1  in a decorated class   SyntaxError: Left side of assignment is not a reference.
this.#n -= 1   in a decorated class   SyntaxError: Left side of assignment is not a reference.
this.#n ||= 1  in a decorated class   SyntaxError: Left side of assignment is not a reference.

this.#n = 5             in a decorated class     OK
this.#n = this.#n + 1   in a decorated class     OK
this.#n += 1            with no decorator        OK
this.n += 1             public field, decorated  OK
```

Three things about the shape of it:

- **The class is what is poisoned, not the decorated method.** A compound assignment
  in the constructor, or in an undecorated private method, fails just the same. Only
  the presence of a decorator anywhere in the class matters.
- **Only the read-modify-write forms.** Plain `=` is fine, so `this.#n = this.#n + 1`
  is the workaround and it is a mechanical rewrite.
- Nothing to do with `@dunx/transform`. Reproduced in `/tmp` with no preload, no
  `bunfig.toml` and a two-line local decorator.

This one is worth knowing rather than filing and forgetting, because dunx makes it
easy to hit: **every controller, gateway, `@JobHandler` and scheduled service is a
decorated class**, and `#count++` is the obvious way to keep a counter in one.

It also sits under an idiom already in shipped code. `this.#x ??= ...` is how six
classes do lazy init - `DashboardMiddleware`, `RedisRelay`, `QueueProcessor`,
`QueueWorker`, `Workspace`, `Application`. None of them is decorated today, so none
is broken; adding one decorator to any of them turns the file into a parse error
with a message that names neither the field nor the decorator.

Found while writing `examples/full/src/schedule/maintenance.service.ts`, whose
`@Cron`/`@Interval`/`@OnceOnBoot` handlers each incremented a private counter.

### A runtime `onLoad` plugin drops the file it loads - unless Bun reads it

**`bun --watch` and `bun --hot` do not restart on a change to any file a runtime
`onLoad` plugin read with `Bun.file`.** Since `@dunx/transform/preload` handles every
`.ts` and `.tsx`, this made `bun run dev` restart on a change to the **entrypoint
only**, in every dunx app.

**Fixed.** `plugin.ts` reads the source through Bun's own loader instead:

```ts
const module = await import(`${path}?`, { with: { type: 'text' } });
return module.default;
```

The file then enters the module graph, so Bun watches it. The `?` is required:
without it the specifier still ends in `.ts` and re-enters the same plugin. From
https://github.com/oven-sh/bun/issues/4689.

Measured on Bun 1.4.0, same entry, same directory, same file edited - the only
variable is how the plugin reads:

```
no preload at all                             RESTARTED
onLoad filter that never matches              RESTARTED
onLoad reading with Bun.file, source verbatim no restart   <- no transform at all
onLoad reading with Bun.file, transformed     no restart
onLoad returning { ..., watchFiles: [path] }  no restart
onLoad returning undefined                    TypeError: onLoad() expects an object returned
onLoad reading with import(..., type: text)   RESTARTED   <- the fix

--watch / --hot, edit an imported file, before the fix   nothing
--watch / --hot, edit the entrypoint, before the fix     RESTARTED
```

What the shape of it says:

- **The transform was never the cause.** A plugin that read a file with `Bun.file`
  and returned it byte for byte broke the watcher identically. What mattered was
  reading it behind Bun's back.
- **The three obvious repairs are all dead ends.** A runtime `onLoad` must return an
  object, so returning `undefined` to decline is a `TypeError`; `watchFiles` on the
  result is accepted and ignored; and `filter` is a path regex, so it cannot skip a
  file whose contents decide whether the transform applies.
- **The fix is free.** `examples/full` boots in 353-365 ms reading through `import`
  against 354-374 ms with `Bun.file`, at 135 MB RSS either way - the same within
  noise across three runs each.
- The entrypoint restarting was the tell: Bun watches the file it was handed before
  any plugin is involved, and nothing after that.

Two smaller behaviours measured while chasing it, both still true: `--hot` is no
different from `--watch` here, and an **mtime-only `touch` does not restart Bun** -
it needs a write event, so rewriting a file with byte-identical content does restart
it while `touch` does not.

`packages/transform/src/watch.test.ts` guards it by spawning a real watch and editing
a real import. Verified to fail - it times out - if the read goes back to `Bun.file`.

Found from a report that editing a `@JobHandler` did nothing. The handler runs in a
forked child, which made the child look like the cause; it was not, and no imported
file of any kind restarted.
