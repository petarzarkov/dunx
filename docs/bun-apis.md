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

| Behaviour                                              | Detail                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `psubscribe` is unusable                               | Present on the prototype, absent from `bun-types`. With a listener it throws `ERR_INVALID_ARG_TYPE`; with patterns alone the promise **never settles** (hung a probe for 120s). `send()` cannot rescue it — the reply has nowhere to go.                                                                                                                                                  |
| `exists()` is lossy                                    | Bun coerces Redis's integer reply to `boolean`, so `exists('a', 'missing')` returns `true`. Use `send('EXISTS', keys)` when you need the count.                                                                                                                                                                                                                                           |
| Bad URLs are accepted                                  | `new Bun.RedisClient('not-a-url')` succeeds, then fails at connect as an opaque `Connection closed`. Validate URLs yourself.                                                                                                                                                                                                                                                              |
| `enableOfflineQueue: false` breaks lazy connect        | The first command is rejected with "offline queue is disabled" even against a healthy server unless you `connect()` first.                                                                                                                                                                                                                                                                |
| A failed connection leaks a retry timer past `close()` | With `maxRetries > 0`, a client that never connects keeps an internal timer alive after `close()` and **the process never exits**. Measured: `maxRetries=1` hung until killed at 6s; `maxRetries=0` exited 0. Reproduced in plain Bun with no framework involved, so nothing in userland can clear it. Use `maxRetries: 0` or `autoReconnect: false` for a connection that may be absent. |
| Subscriber mode throws **synchronously**               | A client in subscriber mode rejects data commands with `ERR_REDIS_INVALID_STATE`, thrown synchronously — `.then(ok, err)` does not catch it. Subscriptions need their own connection.                                                                                                                                                                                                     |

Real but missing from `bun-types`: `psubscribe`, `punsubscribe`, `pubsub`, `script`,
`select`, `connected`, `bufferedAmount`, `onclose`, `onconnect`. Of these `pubsub`,
`script` and `select` work and are reachable through `send()`.

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
- **`Date` bindings are rejected** by both `bun:sqlite` and `Bun.SQL`'s SQLite
  adapter. Convert to ISO 8601 for SQLite; Postgres takes a native binding.
