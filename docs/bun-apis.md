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

## Verified on this machine — Bun 1.3.14

Probed rather than assumed, because the table above is not exhaustive and a few
entries in it are wrong about what is reachable. Extend this section whenever you
verify something; do not delete a line without re-probing it.

```
bun -e "console.log(Object.getOwnPropertyNames(Bun.Image.prototype))"
```

### Present and undocumented

| API                 | Notes                                                            |
| ------------------- | ---------------------------------------------------------------- |
| `Bun.S3Client`      | Absent from the table above. Native S3 — no `@aws-sdk/*` needed. |
| `Bun.embeddedFiles` | Files embedded by `bun build --compile`.                         |
| `Bun.openInEditor`  | Opens a path in the user's editor.                               |
| `Bun.mmap`          | Listed above only as "low-level"; it is a plain function.        |

### `Bun.Image` surface

Barely documented upstream, so the member list matters:

- **statics** — `backend`, `fromClipboard`, `hasClipboardImage`, `clipboardChangeCount`
- **metadata / dimensions** — `metadata()`, `width`, `height`
- **transforms** — `resize`, `rotate`, `flip`, `flop`, `modulate`
- **encoders** — `png`, `jpeg`, `webp`, `avif`, `heic`
- **outputs** — `blob`, `buffer`, `bytes`, `dataurl`, `toBase64`, `toBuffer`, `write`
- **other** — `placeholder`

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
options — read the runtime, not the signature.

### `Bun.RedisClient` — quirks found by probing

`Bun.RedisClient.prototype` carries ~250 methods. Most work. These do not behave as
documented, and each cost real debugging time:

| Behaviour                                              | Detail                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `psubscribe` is unusable                               | Present on the prototype, absent from `bun-types`. With a listener it throws `ERR_INVALID_ARG_TYPE`; with patterns alone the promise **never settles** (hung a probe for 120s). `send()` cannot rescue it — the reply has nowhere to go.                                                                                                                                                                                                                                                                                                                                                                        |
| `exists()` is lossy                                    | Bun coerces Redis's integer reply to `boolean`, so `exists('a', 'missing')` returns `true`. Use `send('EXISTS', keys)` when you need the count.                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Bad URLs are accepted                                  | `new Bun.RedisClient('not-a-url')` succeeds, then fails at connect as an opaque `Connection closed`. Validate URLs yourself.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `enableOfflineQueue: false` breaks lazy connect        | The first command is rejected with "offline queue is disabled" even against a healthy server unless you `connect()` first.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| A failed connection leaks a retry timer past `close()` | With `maxRetries > 0`, a client that never connects keeps an internal timer alive after `close()` and **the process never exits**. Measured: `maxRetries=1` hung until killed at 6s; `maxRetries=0` exited 0. Reproduced in plain Bun with no framework involved, so nothing in userland can clear it. Use `maxRetries: 0` or `autoReconnect: false` for a connection that may be absent.                                                                                                                                                                                                                       |
| Subscriber mode throws **synchronously**               | A client in subscriber mode rejects data commands with `ERR_REDIS_INVALID_STATE`, thrown synchronously — `.then(ok, err)` does not catch it. Subscriptions need their own connection.                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Subscriber mode also leaks past `close()`              | Separate from the retry-timer leak above, and it happens with `maxRetries: 0` against a **healthy** server. A client that ever entered subscriber mode keeps the event loop alive after `close()`, so the process never exits. Measured: subscribe then `close()` hung until killed at 10s; publish-only on the same client exited 0. `await client.unsubscribe()` before `close()` fixes it — with a channel or with no arguments, both work. Any long-lived subscriber must leave subscriber mode on shutdown; `bun test` hides this, because the runner exits the process itself.                            |
| A **failed** `subscribe()` leaks past `close()` too    | The same hazard from the other end, and `maxRetries: 0` does not save you. `subscribe()` against a server that cannot be reached rejects with `Max reconnection attempts reached` and then holds the event loop open after `close()`; `unsubscribe()` cannot rescue it, because the client is not in subscriber mode and rejects with `can only be called while in subscriber mode`. A failed `publish()` on the same url releases cleanly, so it is specific to `subscribe()`. Fix: `await client.connect()` **before** `subscribe()`. Connect fails first, releases cleanly, and reports `Connection closed`. |

#### bullmq holds a handle Bun's `close()` cannot reach — but only once you use it

Measured while wiring `@dunx/infra/queue`, and **the trigger is narrower than it first
looked**. The first isolation was confounded: removing `QueueModule` made the process
exit, but that run also never called the queue, so it proved nothing about the module.
Re-run properly:

| Scenario                                                             | `SIGTERM`       |
| -------------------------------------------------------------------- | --------------- |
| `QueueModule` imported, Redis unreachable, **never published**       | exits in ~1 s   |
| `QueueModule` imported, Redis unreachable, **one publish attempted** | **never exits** |
| `QueueModule` imported, Redis reachable, published                   | exits in ~2 s   |

So the handle is created lazily by the first queue operation, and only leaks when that
operation could not reach Redis. `maxRetries: 0` does not help — verified — because the
connection is bullmq's, held over an `IRedisClient` it was handed, and nothing in
userland can reach it. `Bun.RedisClient` alone is clean in the same scenario: it
rejects with `Max reconnection attempts reached` and the process exits 0.

Consequence: a container that serves a queue route while Redis is down will not exit on
`SIGTERM` and will be `SIGKILL`ed. It serves correctly throughout — the route answers
503 in single-digit milliseconds — so this is a shutdown defect, not an availability
one.

Two neighbouring leaks in `Bun.RedisClient` itself, both fixed in
`@dunx/infra/redis`: a client that entered subscriber mode needs `unsubscribe()`
before `close()`, and a `subscribe()` that failed to connect needs `connect()` first.
`bun test` cannot observe either, because the runner exits the process itself — they
need a spawned process to catch, which is what `@dunx/infra/redis` now has.

**bullmq 6.0.5's CJS build imports `ioredis/built/utils`, which ioredis 6 removed.**
Its ESM build does not, which is why the suite passes on ioredis 6 while a script that
resolves the CJS entry fails with `Cannot find module 'ioredis/built/utils'`. Pin
ioredis 5 if anything might load the CJS path.

Real but missing from `bun-types`: `psubscribe`, `punsubscribe`, `pubsub`, `script`,
`select`, `connected`, `bufferedAmount`, `onclose`, `onconnect`. Of these `pubsub`,
`script` and `select` work and are reachable through `send()`.

### `req.json()` is the cost of a validated request, and there is no native alternative

Measured on `tools/bench`'s validation harness (`bun run validation`), four raw
`Bun.serve` routes answering identical bytes, one adding one step to the last:

| Step                                     | µs/req | adds     |
| ---------------------------------------- | -----: | -------- |
| `GET`, no request body                   |   8.78 | —        |
| `POST`, body on the wire, **never read** |   9.05 | +0.27 µs |
| `POST` + `await req.json()`              |  12.14 | +3.10 µs |
| `POST` + `req.json()` + zod              |  13.09 | +0.94 µs |

**Putting a body on the wire is near-free; reading it is not, and reading it costs
~3.3x what validating it costs.** So the framework-level advice — "pick a faster
validator" — is aimed at the smaller half. Every validator measured (zod, Valibot,
ArkType, TypeBox's compiled checker, ajv) lands between 0.0 µs and 0.94 µs, all of
them under the parse.

**The primitive Bun is missing is a validating parser.** `req.json()` allocates a
full JavaScript object graph which the validator then walks a second time, and
Bun ships nothing that fuses the two: no `Bun.JSON` with a schema, no JSON Schema
validator, no way to validate the body bytes without materialising them first.
`Bun.TOML` and `Bun.markdown` exist; a `Bun.json(bytes, schema)` that answered from
one pass over the buffer would remove most of what a validated POST costs today, and
it is the kind of thing only the runtime can do — a userland library cannot avoid
the intermediate object.

Until then this is a floor, not a dunx cost, and **dunx must not try to fill it**:
Rule 1's second half rules out writing a validator, and a hand-rolled JSON parser
would be a JavaScript reimplementation of a JSC primitive, which the first half
rules out. Recorded here so the ceiling is known rather than rediscovered.

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

### `Bun.file` / `Bun.write` — three data-loss traps

All three reproduced independently, not just reported:

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

### `Bun.S3Client` — the undocumented surface

`prototype`: `delete`, `exists`, `file`, `list`, `presign`, `size`, `stat`,
`unlink`, `write`. Each also exists as a **static**, taking credentials per call.

`client.file(key)` returns an **`S3File extends Blob`** adding `arrayBuffer`,
`bytes`, `delete`, `exists`, `formData`, `image`, `json`, `lastModified`, `name`,
`size`, `slice`, `stat`, `stream`, `text`, `type`, `unlink`, `write`, `writer`,
`presign`, `bucket`.

- `presign()` is **synchronous and offline** — HMAC over the canonical request.
- `stat()` → `{ size, lastModified: Date, etag, type }`, not an fs `Stats`.
- `write()` accepts string / ArrayBufferView / ArrayBuffer / Request / Response /
  BunFile / S3File / Blob / File / Archive — **not** `ReadableStream`. Use
  `file().writer()`, which returns a multipart `NetworkSink`.

### `Bun.Image` — behaviour that will surprise you

Fully typed in `bun-types` (`bun.d.ts` ~8180–8408), just undocumented on the site.

- **Lazy and re-runnable.** Chainables only record; the pipeline runs on a worker
  when a terminal is awaited. A second terminal on the same instance re-runs it.
- **Chainables mutate and return `this`, not a clone — and overwrite.**
  `.resize(10,10).resize(20,20)` yields 20×20. Execution order is fixed at
  `autoOrient → rotate → flip/flop → resize → modulate` regardless of call order.
  A shared instance therefore lets one caller silently reconfigure another's
  transform, which is why a wrapper should be immutable.
- **`metadata()` ignores the chain** and only reads the header, so it reports the
  _source_ dimensions and format. It also succeeds on a truncated file — it is
  **not** a validity check.
- **`width`/`height` are `-1`** until a terminal has been awaited, then hold
  whatever that terminal produced.
- **Decode-only formats do not round-trip.** The types claim a terminal with no
  format setter re-encodes in the source format; for `gif`/`bmp`/`tiff` it actually
  emits **PNG**.
- **`placeholder()` also ignores the chain** — always a ThumbHash of the source.
- Silent clamping, no throw: `resize(0)`, `resize(-5)`, `resize(1.5)` → 1×1;
  `quality` outside 0–100 is clamped. Unknown option _keys_ are ignored, unknown
  `filter` _values_ throw.
- Errors are plain `Error` + `error.code` (`ERR_IMAGE_UNKNOWN_FORMAT`,
  `ERR_IMAGE_DECODE_FAILED`, `ERR_IMAGE_FORMAT_UNSUPPORTED`,
  `ERR_IMAGE_TOO_MANY_PIXELS`), except argument validation which is `TypeError`.
- **Undocumented but present:** `Bun.file(p).image()` and `Blob.prototype.image()`;
  a `data:` URL is accepted as input; `linear` is a valid resize filter despite
  being absent from the error message listing valid names. An `http(s)://` string
  is **not** fetched — it is treated as a path.
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
  type but is `null`** on the SQLite adapter — `count` carries the real number.
- The SQLite adapter does not support `reserve()`.
- **`bun:sqlite`'s `db.transaction()` cannot roll back an async callback.** It
  commits when the function returns its promise, so awaited work is already
  committed and a later throw changes nothing. Issue `BEGIN`/`COMMIT`/`ROLLBACK`
  yourself for async work.
- `Statement.all/get/run/values/iterate` are own properties of the instance, not on
  `Statement.prototype`.
- **`prepare()` compiles one statement and silently drops the rest.** A multi-statement
  string — four `CREATE TABLE`s separated by semicolons — creates the first table only,
  with no error. That reaches through drizzle: `db.run(sql\`…\`)`goes via`prepare`, so
a DDL block has to be one statement per call. `db.exec()`/ the raw handle's`exec()`
  is the one that takes several.
- **A raw `Date` binding fails, but the two adapters fail _differently_.** `bun:sqlite`
  throws `Binding expected string, TypedArray, boolean, number, bigint or null`.
  `Bun.SQL`'s SQLite adapter **accepts it silently and stores `NULL`** — no error, no
  strict switch. Measured:

  ```
  Bun.SQL sqlite ->  ACCEPTED, stored: null
  bun:sqlite     ->  REJECTED: Binding expected string, TypedArray, boolean, ...
  ```

  The silent one is the dangerous one: a timestamp column quietly loses every row.
  Convert to ISO 8601 for SQLite; Postgres takes a native binding.

- **`Bun.SQL` cannot be used with `instanceof`.** `s instanceof Bun.SQL` throws
  `TypeError: instanceof called on an object with an invalid prototype property`,
  which follows from `prototype` being `undefined` above. Narrow on
  `options.adapter`, or hold the client on a class you own.

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
that `@dunx/infra/db`'s `SqlOptions` uses the options-object form — harmless there,
because that backend is Postgres by construction, but any non-Postgres backend
built on `Bun.SQL` must name its `adapter`.

#### An in-flight MySQL query does not hold the event loop open

Measured on 1.3.14, and the failure is silent. A script whose only pending work is
a `Bun.SQL` query on the **MySQL** adapter exits **with code 0, mid-query** — no
error, no unhandled rejection, no output after the last completed statement. The
loop drains because the query holds no reference on it.

A long-running server never sees this, because `Bun.serve` keeps a reference. A CLI,
a migration, a seeder or a one-shot script does. Holding a `setInterval` for the
duration of the work is the workaround; `examples/databases/src/main.ts` does
exactly that and says why. The Postgres adapter and `bun:sqlite` are unaffected.

#### drizzle over `Bun.SQL` for MySQL — verified working

There is no Bun-native drizzle MySQL driver: drizzle 0.45.2's Bun entrypoints are
`bun-sql` (Postgres — `bun-sql/driver.js` builds a `PgDialect` unconditionally, so a
MySQL URL through it emits `$1` placeholders and double-quoted identifiers) and
`bun-sqlite`. Its MySQL drivers are `mysql2` and `mysql-proxy`.

`drizzle-orm/mysql-proxy` over `Bun.SQL` works and keeps Rule 1: drizzle owns the
dialect, Bun owns the socket, `mysql2` is never installed. Verified against MySQL 8
— inserts, selects, `where`, ordering, updates, deletes, aggregates,
`$returningId()` single and multi-row, inner and left joins, `placeholder()`
prepared statements, and the `mysql-proxy` migrator.

Three details the adapter has to get right, all found by running it:

- **`.values()` is mandatory for `method === 'all'`.** drizzle's `mapResultRow`
  indexes rows positionally, and `Bun.SQL`'s default object rows **lose columns on a
  join** — `users.id, users.name, posts.id, posts.name` returns two keys, not four,
  because the later names overwrite the earlier. A manual object→array conversion
  would be silently wrong.
- **`method === 'execute'` covers SELECTs too**, whenever the query carries no
  fields. Return the rows when the result array is non-empty, or `db.execute(sql…)`
  silently yields nothing.
- **`insertId`/`affectedRows` go in `rows[0]`**, not at the top level, despite
  `RemoteCallback`'s declared type — `mysql-proxy/session.js` reads
  `data[0].insertId`. Bun's own property is `lastInsertRowid`.

`mysql-proxy` refuses `db.transaction()` and `iterator()` outright. `Bun.SQL`'s
`begin()` reserves a connection, so a transaction is that plus a second drizzle
handle over the reserved socket. The whole adapter is
`examples/databases/src/mysql/driver.ts`.

### `Bun.color` — `'ansi'` is not a fixed encoding, and can emit a raw newline

`Bun.color(hex, 'ansi')` returns whatever the _current terminal_ is judged to
support, not a stable format. Under `FORCE_COLOR=1` it degrades to `ansi-16`, which
writes the colour **index as a raw byte** rather than decimal digits. Index 10 is
`\n`:

```
FORCE_COLOR=1  Bun.color('#00ff00', 'ansi')      -> "\u001b[38;5;\nm"   contains LF: true
               Bun.color('#00ff00', 'ansi-256')  -> "\u001b[38;5;46m"   contains LF: false
NO_COLOR=1     Bun.color('#00ff00', 'ansi')      -> ""   (Bun.enableANSIColors === false)
```

So a coloured structured-log line built with `'ansi'` silently becomes **two**
records. Ask for **`'ansi-256'`** explicitly, which is well-formed everywhere.

`Bun.enableANSIColors` is the honest capability check — it is `false` under
`NO_COLOR` and for a non-TTY, and it cannot be faked in-process, so testing
degradation needs a real subprocess with stdout piped.
