# Bun APIs

Verified Bun behaviour that dunx depends on or works around. Every entry here was
probed on a real runtime, and each names the Bun version it was measured on. Bun's
own index of its APIs lives at [bun.com/docs](https://bun.com/docs); this file
records where the runtime differs from that index, from its types, or from Node.

Entries are grouped by API. When a later Bun changed a result, the newer result is
the one stated, and the older survives as one line only where a workaround still
depends on it. Findings that Bun fixed and that no longer drive any code are in
[Fixed upstream](#fixed-upstream) at the end.

Extend a section whenever you verify something. Do not delete a line without
re-probing it.

## Findings by Bun version

`engines.bun` is `>=1.4.1`. CI pins 1.4.2 and the deployment guide's image names
it; nothing dunx ships depends on 1.4.2 behaviour.

| Bun                   | Fixed or changed on this version                                                                                                                                                                                                                                                                                                                                                                                                       | Found on this version, still open                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1.3.14                | -                                                                                                                                                                                                                                                                                                                                                                                                                                      | [Redis](#redis) subscriber-mode and failed-`subscribe()` leaks, the retry-timer leak, `psubscribe`; [`POSTGRES_URL` hijack](#postgres_url-in-the-environment-silently-overrides-an-explicit-url) and the [MySQL in-flight query](#an-in-flight-mysql-query-does-not-hold-the-event-loop-open); [`Bun.SQL.prototype`, `db.transaction()`, `prepare()`](#bunsql-and-bunsqlite); [`unref()` semantics](#settimeoutunref---the-semantics-a-forced-exit-depends-on)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 1.4.0 (rev 34cbb9a40) | [`Bun.color` raw newline](#buncolor---ansi-is-not-a-fixed-encoding); [`enterWith` segfault](#fixed-upstream); [SQLite `Date` stored as `NULL`](#bunsql-and-bunsqlite); [Redis pending connect outlives `close()`](#fixed-upstream); [`Bun.cron` honours `{ tz }` and flips the default zone](#buncron---14-honours--tz--and-changed-the-default-zone); Redis server error renamed `ERR_REDIS_SERVER_ERROR`; `{ create: false }` throws | [`writer()` truncation](#bunfile--bunwrite---writer-does-not-truncate); [`deflate` formats](#bundeflatesync-and-compressionstreamdeflate-disagree-on-the-format); [decorators and private fields](#decorators---a-compound-assignment-to-a-private-field-is-a-syntaxerror); [`onLoad` watch](#a-runtime-onload-plugin-drops-the-file-it-loads---unless-bun-reads-it) (worked around); [`?raw` in a worker, stale cache](#bun-test---parallel-is-46x-and-changes-two-things); [`fetch` `protocol: 'http2'`](#fetch-with-protocol-http2-throws-rather-than-falling-back); [`Bun.WebView` hash navigate](#bunwebview---a-headless-browser-in-the-runtime-and-one-trap); [parameter binding](#three-parameter-binding-gaps-between-bunsql-and-a-pg-shaped-library); [directory routes](#bunserve-directory-routes----dir--new-in-14); [OTel](#opentelemetry-on-14---require-only-and-it-never-sees-bunserve); [stdin line](#one-line-of-stdin-keeps-the-process-alive); [`errno`](#database-drivers-put-the-servers-error-code-in-errno-not-code) |
| 1.4.1 (rev 4661e494f) | [`Bun.write` takes a stream](#bunwrite-takes-a-stream-and-it-is-the-whole-local-write-path); [`--coverage --parallel`](#--coverage---parallel-agrees-with-sequential); [HTTP/1.0 upgrade leak](#fixed-upstream) (1.4.0 only)                                                                                                                                                                                                           | [`NetworkSink.end(error)` commits](#networksinkenderror-commits-the-upload-rather-than-aborting-it)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 1.4.2 (rev 744846f84) | [nested `run()` retention](#a-nested-asynclocalstoragerun-held-the-enclosing-store); [CMYK JPEG decode](#bunimage); [`bun build` `var`/`let` rename, `.json()` message](#fixed-upstream)                                                                                                                                                                                                                                               | [`idleTimeout` severs a stream](#idletimeout-severs-a-streaming-response-and-servertimeout-exempts-one); [`resolveSync` past `exports`](#bunresolvesync-reaches-packagepackagejson-past-an-exports-map); [`Bun.Glob` escapes `cwd`](#bunglobscan---cwd-is-where-a-pattern-starts-not-a-boundary); [transpiler cache](#the-transpiler-cache-is-content-keyed-across-paths-and-a-docs-failure-it-did-not-cause); [`Query` `then` runs twice](#a-bunsql-querys-then-runs-twice-per-await)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

On 1.4.2 these still reproduce: `writer()` not truncating, `fetch` with
`protocol: 'http2'` against a cleartext peer, `internal/docs` under
`bun test --parallel` (38 of 92 fail, so the `docs` phase keeps its exclusion), and
a compound assignment to a private field beside a decorated member.

## Runtime surface

### Present and undocumented

These exist and are missing from, or misdescribed by, Bun's API index:

| API                 | Notes                                                                 |
| ------------------- | --------------------------------------------------------------------- |
| `Bun.S3Client`      | Native S3, no `@aws-sdk/*` needed. See [Files and S3](#files-and-s3). |
| `Bun.YAML`          | `{ parse, stringify }`. See below.                                    |
| `Bun.embeddedFiles` | Files embedded by `bun build --compile`.                              |
| `Bun.openInEditor`  | Opens a path in the user's editor.                                    |
| `Bun.mmap`          | The index lists it only as "low-level"; it is a plain function.       |
| `Bun.Terminal`      | A PTY. `Bun.spawn(cmd, { terminal })` gives the child a real one.     |
| `Bun.sliceAnsi`     | Slices by terminal columns without severing an escape sequence.       |
| `Bun.stripANSI`     | The inverse, for asserting on what a frame says.                      |
| `Bun.TOML`          | `{ parse, stringify }`; `stringify` is undocumented.                  |

- **Confirmed reachable on 1.3.14**: `Bun.serve`, `Bun.SQL`, `Bun.sql`,
  `Bun.RedisClient`, `Bun.redis`, `Bun.Image`, `Bun.Glob`, `Bun.file`, `Bun.write`,
  `Bun.password`, `Bun.CryptoHasher`, `Bun.zstdCompressSync`, `Bun.CookieMap`,
  `Bun.udpSocket`, `Bun.listen`, `Bun.connect`, `Bun.FileSystemRouter`,
  `Bun.ArrayBufferSink`, `Bun.randomUUIDv7`, `Bun.inflateSync`, `Bun.Transpiler`,
  `Bun.color`, `Bun.semver`, `Bun.markdown`, `Bun.TOML`, `Bun.YAML`, `Bun.which`,
  `Bun.hash`, `Bun.CSRF`, `Bun.dns`, `Bun.stringWidth`, `Bun.escapeHTML`,
  `Bun.deepEquals`, `Bun.peek`, `Bun.readableStreamToBytes`, `Bun.build`.
- **Modules**: `bun:sqlite` (exports `Database`, `Statement`, `SQLiteError`, `constants`),
  `bun:yaml`, `bun:ffi`, `bun:jsc`, `bun:test`.

- **Added in 1.4.0**: `Bun.Image`, `Bun.WebView`, `Bun.markdown` (`html`,
  `ansi`, `render`, `react`), `Bun.cron`, `Bun.Terminal`, `Bun.JSON5`, `Bun.JSONL`,
  `Bun.JSONC` (`parse` only), `Bun.XML`, `Bun.TOML.stringify`, `Bun.Archive` (`write`
  only), `Bun.sliceAnsi`, `Bun.wrapAnsi`, plus `CompressionStream`,
  `DecompressionStream`, `URLPattern` and `Response.prototype.textStream` as globals.

- **Added in 1.4.1**: `Bun.serve({ http2, http1 })`, `binaryType: 'blob'` on
  a `ServerWebSocket`, `WebSocket.prototype.pause`/`resume`/`isPaused`, and
  `crypto.argon2`/`argon2Sync` in `node:crypto`. `http2` and `http1` are marked
  `@experimental` in `bun-types`; `http3` is declared alongside them and was not
  probed.

`Bun.SQL` and `Bun.RedisClient` both report `.length === 0`, so constructor arity
tells you nothing about their options. Read the runtime, not the signature.

### `Bun.resolveSync` reaches `<package>/package.json` past an `exports` map

Node refuses a subpath an `exports` map does not list. Bun refuses the same, with
one exception that `@dunx/openapi`'s renderers depend on:

```ts
Bun.resolveSync('@scalar/api-reference/package.json', dir); // resolves
Bun.resolveSync('@scalar/api-reference/dist/browser/standalone.js', dir);
// Cannot find package '@scalar/api-reference' imported from ...
```

`@scalar/api-reference` 1.68.0 lists nine subpaths and `./package.json` is not one
of them. `PackageAssets` resolves the manifest, reads `version` off it for the
cache-busting query, and joins the asset path onto its directory, so the one
specifier it hands Bun works whether or not the package has an `exports` map.
`swagger-ui-dist` has none at all and resolves either way.

Probed on 1.4.2 rev `744846f84`. If this ever tightens to match Node, the fallback
is `Bun.resolveSync('<package>', dir)`, which resolves the `.` entry, and walking
up from its directory.

### `Bun.YAML` parses config, and a duplicate key takes the last silently

On 1.4.2 `Bun.YAML` is `{ parse, stringify }`, and `bun:yaml` resolves as a builtin
carrying the `yaml` package's surface: `Document`, `Composer`, `parseDocument`,
`parseAllDocuments`, `visit`. Scalars come back typed, so a config file needs no
coercion pass:

```
server:   { port: 3000, host: "0.0.0.0" }   port     -> number
database: { poolSize: 10, ssl: false }      ssl      -> boolean
empty:                                       empty   -> null
```

- **A duplicate key does not throw.** `a: 1\na: 2` parses to `{"a": 2}`. The `yaml`
  package rejects that under its default schema; `Bun.YAML` keeps the last one.
- **A multi-document stream returns an array.** `a: 1\n---\nb: 2` parses to
  `[{"a":1},{"b":2}]`, so a stray `---` turns an object into a list and parses
  clean.
- **A parse error is a `SyntaxError`** reading `YAML Parse error: Unexpected token`.

| Reading `application.yml`                        | Result                                                                                                   |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| `await import('./application.yml')` in a package | resolves against **that module**, so a published `dist/` looks beside itself instead of in the app's cwd |
| `await import(absolutePath)`                     | works, and parses                                                                                        |
| `await import(missingPath)`                      | throws `ResolveMessage`                                                                                  |
| `Bun.file(missingPath).exists()`                 | `false`                                                                                                  |

An optional per-environment overlay needs the last row, so `Bun.file(abs).text()`
plus `Bun.YAML.parse` is the pairing for a config loader, not a dynamic import.

### `node:perf_hooks` histograms - four edges, unchanged on 1.4.0

`createHistogram()` and `monitorEventLoopDelay()` both work and are undocumented on
Bun's side. Measured on 1.4.0: `record()` **11.1 ns**, `percentile(99)` **3.9 us**,
`mean` **42.2 us**, `process.memoryUsage()` **12.7 us**.

| Edge                       | Behaviour                                                                        |
| -------------------------- | -------------------------------------------------------------------------------- |
| `record(0)` / `record(-1)` | `RangeError [ERR_OUT_OF_RANGE]`. Clamp to 1.                                     |
| empty histogram            | `min` 9223372036854776000, `mean` `NaN`, `max` 0. Never serialise `count === 0`. |
| `percentiles`              | a `Map` of `bigint`, so `JSON.stringify` yields `{}` with **no error**           |
| `toJSON`                   | absent under Bun                                                                 |

Serialising the `percentiles` Map is silent data loss; extracting a value and
stringifying that throws `JSON.stringify cannot serialize BigInt`. `percentile(n)`
returns a `number`.

`process.memoryUsage()` reports `heapUsed` **larger** than `heapTotal` routinely
under JSC (9.6 MB against 7.1 MB was one observed pair), so an assertion that
`heapTotal >= heapUsed` fails intermittently.

## HTTP and WebSocket

### `idleTimeout` severs a streaming response, and `server.timeout()` exempts one

`Bun.serve` closes a connection that goes `idleTimeout` seconds without traffic,
10 by default, and a response already streaming is not exempt. A body with 13
seconds between chunks, on 1.4.2:

```
[client] T+0.0s   chunk ": open\n\n"
[client] T+12.0s  ERROR The socket connection was closed unexpectedly
[server] enqueue  Invalid state: Controller is already closed
warn: Bun.serve() timed out a request after 10 seconds. Pass `idleTimeout` to configure.
```

An event stream is the case that breaks, since idling is what it is for.

| Question                                                    | Answer on 1.4.2                                        |
| ----------------------------------------------------------- | ------------------------------------------------------ |
| Does `server.timeout(req, 0)` exist and hold a stream open? | yes - the same body delivered its chunk at T+13.0s     |
| Does a route handler receive the server?                    | yes, as the second argument, `timeout` included        |
| Does a `BunRequest` carry a handle to its server?           | no - no own or prototype property names one            |
| `server.timeout(req, n)` for a foreign request              | silent no-op, and the owning server's call still takes |

The second row decided the design. A registry of bound servers was written first,
on the third and fourth rows, and thrown away: Bun hands the owning server to the
route table entry and to the `fetch` fallback, so a route that declares it idles,
and an RPC on the unmatched path, each clear their own deadline on the right server
with no registry. The third row still rules out reading the server back off a
request.

**The sever does not land at `idleTimeout`.** Reaping runs on Bun's own sweep, a
4 second timer, so it lands at the next 4 second boundary at or after it. One chunk
at T+0 then a 60s sleep:

| `idleTimeout` | Severed at | `ceil(t / 4) * 4` |
| ------------- | ---------- | ----------------- |
| 5             | 8.0s       | 8                 |
| 7             | 8.0s       | 8                 |
| 8             | 8.0s       | 8                 |
| 10 (default)  | 12.0s      | 12                |
| 11            | 12.0s      | 12                |
| 12            | 12.0s      | 12                |
| 15            | 16.0s      | 16                |
| 30            | 32.0s      | 32                |
| 0             | never      | -                 |

So `idleTimeout: 1` closes the socket **4.0 s** after the last byte, and a
regression test needs a gap past the **boundary**, not past `idleTimeout`. An 11s
gap on the default passes with the fix removed.

**Reading the request body makes no difference.** Holding the gap at 13s, a `GET`
with no read, a `GET` with `arrayBuffer()` and a `POST` with `arrayBuffer()` all
severed at 12.0s. An earlier reading blamed the body read; it was two probes that
differed in gap, both near the 12.0s boundary.

### `Bun.serve` directory routes - `{ dir }`, new in 1.4

`{ dir: './public' }` as a route value serves a directory natively. Probed on 1.4.0
against a wildcard route (`'/assets/*'`):

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

| Gap                                           | Detail                                                                                                                                                                                                            |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **No `cache-control`, and no way to set one** | `DirectoryRouteOptions` is `{ dir, statCache }` and nothing else. A `headers` key is accepted and **silently ignored**. Since Bun answers the route itself, a dunx middleware never sees the response to add one. |
| **Every HTTP method is served**               | `GET`, `HEAD`, `POST`, `PUT`, `DELETE`, `PATCH` and `OPTIONS` all return **200 with the file body**. So `DELETE /assets/app.js` answers with the script, and `OPTIONS` cannot carry CORS preflight headers.       |
| No `x-content-type-options: nosniff`          | Not set, and not settable for the same reason as `cache-control`.                                                                                                                                                 |

`index` is **half-implemented**: it is type-checked at `Bun.serve` (`index: false`
throws `The "index" property must be of type string`), undeclared in `bun-types`,
and then ignored, so `{ dir, index: 'a.txt' }` still serves `index.html`.

`@dunx/http`'s `StaticFiles` exists for the cache policy, so `{ dir }` does not
replace it. The first two gaps are what a swap is waiting on.

### `Bun.serve({ http2: true })` serves h2c, and `fetch` still cannot speak it

Probed on 1.4.1 with `node:http2` as the client, since it opens with the connection
preface: routes match, `req.url` is the full URL, a POST body streams, the `fetch`
fallback answers a miss, HTTP/1.1 keeps working on the same port, and a websocket
upgrade still succeeds alongside it.

`http1: false` answers **505** to every HTTP/1.x request, which takes every gateway
with it, since a websocket upgrade is an HTTP/1.1 request. `@dunx/http` refuses to
boot when the pair is set with a gateway declared and no `gatewayPort` to move it
to.

`Bun.serve` accepts an unknown option silently, so acceptance of `http2` proves
nothing on its own, and the probe asserts on the wire.

#### What h2c is worth, and why the number is server CPU rather than req/s

oha 1.15.0, 64 requests in flight both ways (`-c 64` against
`-c 4 -p 16 --http2`), 5s per cell, median of three runs on a 32-core Linux box,
against an `@dunx/http` app with `requestLogging: false`.

oha's HTTP/1.1 client burns **210% CPU to put the server at 85%** of its single
event-loop core, so a bare req/s comparison partly measures the load generator.
Server CPU per request, read from `/proc/<pid>/stat` for the server process alone,
does not have that problem. The two ratios agree to within about 7%, so the
throughput figure is mostly real.

| Route             | h1 req/s | h2 req/s | ratio | h1 CPU/req | h2 CPU/req | ratio | h1 p99  | h2 p99  |
| ----------------- | -------- | -------- | ----- | ---------- | ---------- | ----- | ------- | ------- |
| GET, 13-byte body | 131,202  | 378,281  | 2.88x | 7.88 µs    | 2.90 µs    | 2.70x | 0.94 ms | 0.30 ms |
| GET, JSON         | 127,556  | 365,152  | 2.86x | 8.07 µs    | 2.97 µs    | 2.71x | 0.96 ms | 0.30 ms |
| POST, 4 KiB body  | 80,589   | 169,178  | 2.10x | 13.45 µs   | 6.77 µs    | 1.96x | 1.48 ms | 0.74 ms |
| GET, 64 KiB body  | 36,501   | 46,884   | 1.29x | 31.67 µs   | 25.42 µs   | 1.24x | 3.34 ms | 2.38 ms |

**The win is per-request overhead, so it shrinks as the body grows**: 2.9x on a
13-byte response and 1.3x on a 64 KiB one, where the cost is moving bytes. Raw
`Bun.serve` on the same driver runs the same shape a little higher (3.16x, 2.98x,
2.22x, 1.40x), so the ratio is Bun's and `@dunx/http` neither adds nor removes it.

### `fetch` with `protocol: 'http2'` throws rather than falling back

Bun 1.4 added `protocol` to `BunFetchRequestInit`: `'http2' | 'http1.1' | 'h2' | 'h1'`.
`'http2'` lets concurrent requests to one origin share a connection.

Against a cleartext `http://` origin it does not negotiate down. Both `'http2'` and
`'h2'` reject with a `TypeError` whose `code` is `HTTP2Unsupported`, where
`'http1.1'` and an unset `protocol` both return 200 from the same `Bun.serve`.
Re-probed on 1.4.1 against a `Bun.serve({ http2: true })` that `node:http2` speaks
to over h2c: unchanged, so this is the client. Still reproduces on 1.4.2.

So an app calling a plain-HTTP upstream must leave it unset. `examples/full` calls
itself over HTTP and does exactly that; setting it there turned the tour into a
`HTTP2Unsupported` at the first outbound call. `@dunx/http/client` passes it
through and does not interpret it.

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
  **`binaryType` is not one of them**, though each `ServerWebSocket` carries it as a
  mutable property, so a server-wide setting has to be assigned as each connection
  opens. `@dunx/http` does that in its `open` handler. 1.4.1 added `'blob'` to the
  `'nodebuffer' | 'arraybuffer' | 'uint8array'` it already took.

| Behaviour                                     | Detail                                                                                                                 |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Unknown `websocket` keys are silently ignored | A typo'd option is a no-op. Derive your option type from Bun's with `Pick` so it cannot drift.                         |
| `idleTimeout` above 960 throws                | Rejected at `Bun.serve`, not clamped.                                                                                  |
| Graceful `stop()` hangs with a live WebSocket | `server.stop()` never resolves while a socket is open; `stop(true)` is required, and clients then see close code 1006. |
| Close `reason` arrives empty                  | Once frames have been exchanged, `close()` receives an empty `reason`. The code is reliable; the reason is not.        |
| No way to enumerate server sockets            | So a graceful per-socket close before shutdown is not possible.                                                        |
| Bun's _client_ `WebSocket` is non-standard    | It has extra `ping`/`pong`/`terminate` methods.                                                                        |

Native pub/sub (`socket.subscribe(topic)` / `server.publish(topic, data)`) is real
and should be used instead of a JavaScript topic registry.

### `req.json()` is the cost of a validated request, and there is no native alternative

Measured on `internal/bench`'s validation harness (`bun run validation`), four raw
`Bun.serve` routes answering identical bytes, each adding one step to the last:

| Step                                     | µs/req | adds     |
| ---------------------------------------- | -----: | -------- |
| `GET`, no request body                   |   8.78 | -        |
| `POST`, body on the wire, **never read** |   9.05 | +0.27 µs |
| `POST` + `await req.json()`              |  12.14 | +3.10 µs |
| `POST` + `req.json()` + zod              |  13.09 | +0.94 µs |

**Putting a body on the wire is near-free. Reading it costs ~3.3x what validating
it costs.** Every validator measured (zod, Valibot, ArkType, TypeBox's compiled
checker, ajv) lands between 0.0 µs and 0.94 µs, all under the parse, so "pick a
faster validator" is aimed at the smaller half.

`req.json()` allocates a full object graph and the validator walks it a second
time. Bun ships nothing that fuses the two: no `Bun.JSON` with a schema, no JSON
Schema validator, no way to validate body bytes without materialising them.
`Bun.TOML` and `Bun.markdown` exist, so Bun does not avoid parsers; a
`Bun.json(bytes, schema)` answering from one pass would remove most of what a
validated POST costs, and only the runtime can build it.

Until then this is a floor, not a dunx cost. **dunx must not try to fill it**: Rule
1 rules out both writing a validator and a JavaScript reimplementation of a JSC
parser.

### `Bun.deflateSync` and `CompressionStream('deflate')` disagree on the format

`Content-Encoding: deflate` means zlib (RFC 1950). Measured on 1.4.0:

| Encoder                            | First bytes | Format      |
| ---------------------------------- | ----------- | ----------- |
| `Bun.deflateSync(data)`            | `cb 48`     | raw DEFLATE |
| `new CompressionStream('deflate')` | `78 9c`     | zlib        |
| `node:zlib`'s `deflateSync`        | `78 9c`     | zlib        |

`DecompressionStream('deflate')` decodes the stream output and throws
`inflate failed` on the sync one. `{ library: 'zlib' }`, `{ windowBits: 15 }`,
`{ windowBits: -15 }` and `{ level: 6 }` all leave `deflateSync` raw.

`@dunx/http`'s `Compression` picks the sync encoder for a body it can buffer and
`CompressionStream` for one it cannot, so offering `deflate` would change the wire
format at the buffering threshold. It offers `zstd` and `gzip` only; `gzip` is
accepted by everything that would have taken `deflate`. `Bun.gzipSync` and
`CompressionStream('gzip')` agree, and so do the two zstd encoders.

## SQL

### `Bun.SQL` and `bun:sqlite`

- **`Bun.SQL.prototype` is `undefined`.** It is a native constructor whose instances
  are callable functions; `unsafe`, `begin`, `close`, `connect`, `options`,
  `reserve` are own properties of the _instance_. Probing the prototype throws, and
  `s instanceof Bun.SQL` throws `TypeError: instanceof called on an object with an
invalid prototype property`. Narrow on `options.adapter`, or hold the client on a
  class you own. Still true on 1.4.0.
- **`typeof new Bun.SQL(url)` is `'function'`**, since the client is callable as a
  tagged template. A `typeof x === 'object'` guard skips the whole Postgres backend.
- **`client.unsafe(sql, params)` is lazy.** It returns a `Query` that is
  `instanceof Promise` but does not execute until awaited. Its prototype carries
  `execute`, `run`, `raw`, `simple`, `values`, `then`, `catch`, `finally`.
  Attaching `.finally()` to time it **starts the query**; wrapping `then` does not,
  and the first `then` is the moment execution begins. Verified against Postgres 16.
- Supported adapters are exactly `postgres`, `sqlite`, `mysql`, `mariadb`. **`pg://`
  is not supported**; `postgresql://`, `file:` and `sqlite://` are.
- A **schemeless** URL is silently treated as a Postgres _host_: `{ url: './dev.db' }`
  reports `adapter: 'postgres'` and fails much later with a socket error.
- Result metadata hangs off the returned array, and `affectedRows` **exists in the
  type but is `null`** on the SQLite adapter; `count` carries the real number.
- The SQLite adapter does not support `reserve()`.
- **`bun:sqlite`'s `db.transaction()` cannot roll back an async callback.** It
  commits when the function returns its promise, so awaited work is already
  committed and a later throw changes nothing. Issue `BEGIN`/`COMMIT`/`ROLLBACK`
  yourself for async work. Still true on 1.4.0.
- `Statement.all/get/run/values/iterate` are own properties of the instance, not on
  `Statement.prototype`.
- **`{ create: false }` throws on a missing file** from 1.4, with
  `bad parameter or other API misuse`; 1.3.14 created the file. `{ readonly: true }`
  refuses on both with `unable to open database file`, so it is the portable way to
  require an existing database.
- **`prepare()` compiles one statement and silently drops the rest.** Four
  `CREATE TABLE`s separated by semicolons create the first table only, with no
  error. That reaches through drizzle: ``db.run(sql`…`)`` goes via `prepare`, so a
  DDL block has to be one statement per call. `db.exec()` or the raw handle's
  `exec()` takes several. Still true on 1.4.0.
- **A raw `Date` binding is rejected by both adapters on 1.4**, with
  `Binding expected string, ...`. On 1.3.14 the `Bun.SQL` SQLite adapter accepted it
  and stored `null`, losing every timestamp with no error; an app that relied on the
  silence now throws on upgrade. Convert to ISO 8601 for SQLite; Postgres takes a
  native binding.

### `POSTGRES_URL` in the environment silently overrides an explicit `url`

Measured on 1.3.14. In the **options-object** form only,
`new Bun.SQL({ url: 'mysql://…' })` becomes `adapter: 'postgres'` and dials the
Postgres URL from the environment, failing with a bare `Connection closed` that
names nothing.

| Variable set                | `new Bun.SQL({ url: mysqlUrl })`   |
| --------------------------- | ---------------------------------- |
| `POSTGRES_URL`              | **hijacked** → `adapter: postgres` |
| `PGURL`                     | **hijacked** → `adapter: postgres` |
| `TLS_POSTGRES_DATABASE_URL` | **hijacked** → `adapter: postgres` |
| `DATABASE_URL`              | ok → `adapter: mysql`              |
| `MYSQL_URL`                 | ok → `adapter: mysql`              |

Three forms are unaffected, all verified: `new Bun.SQL(urlString)`,
`new Bun.SQL(new URL(url))`, and `new Bun.SQL({ url, adapter: 'mysql' })`.
`@dunx/infra/db`'s `SqlOptions` uses the options-object form, which is harmless
there because that backend is Postgres by construction. Any non-Postgres backend
built on `Bun.SQL` must name its `adapter` explicitly.

### `LISTEN`/`NOTIFY` on the Postgres adapter, and the 7999-byte cap

Measured on 1.4.0 (rev 34cbb9a40) against Postgres 17.
`sql.listen(channel, cb, onReconnect)` resolves once the server acknowledges the
`LISTEN`; `sql.notify(channel, payload)` publishes. Delivery between two clients
works, and `unlisten()` ends it:

```
handle:                    { own: ["channel"], unlisten: fn, asyncDispose: fn }
cross-connection delivery: [ "first" ]
after unlisten:            [ "first" ]
```

The payload ceiling is exact:

```
7998 -> accepted
7999 -> accepted
8000 -> payload string too long
```

Postgres only. The SQLite adapter answers `LISTEN/NOTIFY is not supported by this
adapter (PostgreSQL only)`.

`notify()` returns a `Query`, and `Query` extends `Promise`, so a rejection reaches a
`.then(onOk, onErr)` pair. `PubSub`'s `#outbound` branches on that test, so a relay
built on `notify` reports its failures through the normal degrade path rather than
raising an unhandled rejection.

### Three parameter-binding gaps between `Bun.SQL` and a `pg`-shaped library

Measured on 1.4.0 rev `34cbb9a40` against Postgres 17.11, while running pg-boss over
`Bun.SQL`. Each is something `pg` does that `Bun.SQL` does not.

**Transaction control is refused on a pooled connection.** A multi-statement string
opening with `BEGIN` throws `Only use sql.begin, sql.reserved or max: 1`. The same
string through `sql.reserve()` runs and returns one result array per statement, so a
caller reading `rows` takes the last of them.

**A JS array parameter is comma-joined rather than made into an array literal.** Both
forms fail identically:

```
sql.unsafe('SELECT $1::text[]', [['probe','other']]) -> malformed array literal: "probe,other"
sql`SELECT ${['probe','other']}::text[]`             -> malformed array literal: "probe,other"
```

An `int[]` cast fails at the wire protocol: `SELECT $1::int[]` bound to `[1, 2]`
answers `insufficient data left in message`.

`sql.array()` is the supported path. It binds `json[]`, which holds only while
nothing casts it:

```
sql`SELECT ${sql.array(['a','b'])}`             -> [ "a", "b" ]
sql`SELECT ${sql.array([1,2])}::int[]`          -> cannot cast type json[] to integer[]
sql`SELECT ${sql.array(['a','b'])}::text[]`     -> [ "\"a\"", "\"b\"" ]
```

In the third, each element arrives three characters long, carrying the JSON quotes,
and an `INSERT` into a real `text[]` column stores them that way with no error. A
library that writes its own `$n::type` casts meets this on every array parameter,
which keeps the pg-boss adapter from shrinking to `executeSql` plus `listen`. The
literal Postgres spelling still binds correctly: `'{probe,other}'` reads back as
`[ "probe", "other" ]`.

The `sql.array()` cast defect is filed as
[#41242](https://github.com/oven-sh/bun/issues/41242). Four earlier issues shipped
`sql.array()` and are closed as completed, the last two on 2025-09-27 and
2025-09-30, before 1.4.0; the raw-array and cast paths above still fail:
[#16840](https://github.com/oven-sh/bun/issues/16840),
[#17798](https://github.com/oven-sh/bun/issues/17798),
[#18775](https://github.com/oven-sh/bun/issues/18775),
[#22165](https://github.com/oven-sh/bun/issues/22165).

**A JSON string bound to a `::json` cast arrives as a JSON scalar:**

```
$1 = JSON.stringify([{ id: 1 }])   json_typeof -> string
$1 = [{ id: 1 }]                   json_typeof -> array
```

So `json_to_recordset($1::json)` fails with `cannot call json_to_recordset on a
scalar` against a string a `pg`-based library already stringified, and succeeds
against the raw value. Filed as [#40942](https://github.com/oven-sh/bun/issues/40942).

### An in-flight MySQL query does not hold the event loop open

Measured on 1.3.14, and the failure is silent. A script whose only pending work is a
`Bun.SQL` query on the **MySQL** adapter exits **with code 0, mid-query**: no error,
no unhandled rejection, no output after the last completed statement.

A long-running server never sees this, because `Bun.serve` keeps a reference. A CLI,
a migration, a seeder or a one-shot script does. Holding a `setInterval` for the
duration of the work is the workaround, and `examples/databases/src/main.ts` does
exactly that. The Postgres adapter and `bun:sqlite` are unaffected.

### drizzle over `Bun.SQL` for MySQL - verified working

drizzle 0.45.2 has no Bun-native MySQL driver. Its Bun entrypoints are `bun-sql`
(Postgres: `bun-sql/driver.js` builds a `PgDialect` unconditionally, so a MySQL URL
through it emits `$1` placeholders and double-quoted identifiers) and `bun-sqlite`.
Its MySQL drivers are `mysql2` and `mysql-proxy`.

`drizzle-orm/mysql-proxy` over `Bun.SQL` works: drizzle owns the dialect, Bun owns
the socket, and `mysql2` is never installed. Verified against MySQL 8: inserts,
selects, `where`, ordering, updates, deletes, aggregates, `$returningId()` single and
multi-row, inner and left joins, `placeholder()` prepared statements, and the
`mysql-proxy` migrator.

- **`.values()` is mandatory for `method === 'all'`.** drizzle's `mapResultRow`
  indexes rows positionally, and `Bun.SQL`'s default object rows **lose columns on a
  join**: `users.id, users.name, posts.id, posts.name` returns two keys, because the
  later names overwrite the earlier.
- **`method === 'execute'` covers SELECTs too**, whenever the query carries no
  fields. Return the rows when the result array is non-empty, or `db.execute(sql…)`
  silently yields nothing.
- **`insertId`/`affectedRows` go in `rows[0]`**, despite `RemoteCallback`'s declared
  type: `mysql-proxy/session.js` reads `data[0].insertId`. Bun's own property is
  `lastInsertRowid`.

`mysql-proxy` refuses `db.transaction()` and `iterator()` outright. `Bun.SQL`'s
`begin()` reserves a connection, so a transaction is that plus a second drizzle
handle over the reserved socket. The adapter is `examples/databases/src/mysql/driver.ts`.

### Database drivers put the server's error code in `errno`, not `code`

Measured on 1.4.0 against `bun:sqlite`, Postgres 16 and MySQL 8.0, by provoking each
violation. `packages/infra/src/db/errors.ts` maps these; `errors.test.ts` provokes
them again rather than asserting a fixture.

The two `Bun.SQL` backends put their own label in `code` and the server's code in
`errno`, the reverse of `pg` and `mysql2`, which keep the SQLSTATE in `.code`.
Reading `code` gets `ERR_POSTGRES_SERVER_ERROR` for a unique violation, a missing
table and a bad cast alike.

| Driver       | class                            | `code`                      | `errno`             |
| ------------ | -------------------------------- | --------------------------- | ------------------- |
| `bun:sqlite` | `Error`, `name` is `SQLiteError` | `SQLITE_CONSTRAINT_UNIQUE`  | `2067`, an integer  |
| Postgres     | `PostgresError`                  | `ERR_POSTGRES_SERVER_ERROR` | `'23505'`, a string |
| MySQL        | `MySQLError`                     | `ERR_MYSQL_SERVER_ERROR`    | `1062`, a number    |

- **`bun:sqlite` puts the useful code in `code`**, and its error is a plain `Error`
  with `name` set, so `instanceof` finds nothing to narrow on.
- **`errno` is a string on Postgres and a number on MySQL.** The two spaces do not
  collide, so one lookup table works, keyed by `String(errno)`.
- **Only Postgres names the constraint on a field.** `constraint` holds
  `users_email_key`; SQLite has to be read out of the message
  (`UNIQUE constraint failed: users.email`), and MySQL names it in the message only
  for a duplicate index or a check.

MySQL reports a duplicate primary key as `1062`, the same as any duplicate index
entry, where SQLite and Postgres both distinguish it (`SQLITE_CONSTRAINT_PRIMARYKEY`,
and `23505` with a `_pkey` constraint name).

### A `Bun.SQL` query's `then` runs twice per `await`

Measured on 1.4.2 against Postgres 17. `Bun.SQL`'s `unsafe()` returns a lazy
`Query` that runs when awaited, and one `await` calls its `then` **twice**,
keeping only one result. A wrapper that answers every `then` with a promise of
its own leaves the other one rejecting with no handler, so a failed query the
caller caught still surfaces as an unhandled rejection:

```
passthrough: then calls=2 caught=true unhandled=0
own: then calls=2 caught=true unhandled=1
```

`passthrough` hands each call to Bun's own `then`; `own` returns
`running.then(onOk, onErr)` from a promise the wrapper made once. Anything that
instruments a query, as `packages/infra/src/db/instrument.ts` does for metrics and
spans, has to observe one settlement on the side and return `originalThen(onOk,
onErr)` from every call. The unhandled rejection only shows against a real
server, which is why a stand-in thenable in a unit test never caught it.

## Redis

### `Bun.RedisClient` - quirks found by probing

`Bun.RedisClient.prototype` carries 213 methods on 1.4.0, and an instance has **no
own properties at all**. Every row below still reproduces on 1.4 unless it says
otherwise:

| Behaviour                                              | Detail                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `psubscribe` is unusable                               | Present on the prototype, absent from `bun-types`. With a listener it throws `ERR_INVALID_ARG_TYPE`; with a pattern alone it resolves in under a millisecond (re-measured on 1.3.14; an earlier note said it hung for 120s), but the client exposes no hook for pattern messages (`onmessage`, `onpmessage` and `onMessage` are all `undefined`), so a delivery has nowhere to go.                                                                                                                                      |
| A server error's `code` changed name in 1.4            | An error Redis itself returned (`WRONGTYPE`, `ERR unknown command`, a wrong argument count) carries `ERR_REDIS_SERVER_ERROR` on 1.4 and carried `ERR_REDIS_INVALID_RESPONSE` on 1.3. `@dunx/infra/redis` exports `isServerError()`, which spans both. The floor is 1.4.1 as of 3.3.0, so only the 1.4 name can arrive; the 1.3 constant stays because it is exported.                                                                                                                                                   |
| `exists()` is lossy                                    | Bun coerces Redis's integer reply to `boolean`, so `exists('a', 'missing')` returns `true`. Use `send('EXISTS', keys)` for the count.                                                                                                                                                                                                                                                                                                                                                                                   |
| Bad URLs are accepted                                  | `new Bun.RedisClient('not-a-url')` succeeds, then fails at connect as an opaque `Connection closed`. Validate URLs yourself.                                                                                                                                                                                                                                                                                                                                                                                            |
| `enableOfflineQueue: false` breaks lazy connect        | The first command is rejected with "offline queue is disabled" even against a healthy server unless you `connect()` first.                                                                                                                                                                                                                                                                                                                                                                                              |
| A failed connection leaks a retry timer past `close()` | With `maxRetries > 0`, a client that never connects keeps an internal timer alive after `close()` and **the process never exits**. `maxRetries=1` hung until killed at 6s; `maxRetries=0` exited 0. Reproduced in plain Bun, so nothing in userland can clear it. Use `maxRetries: 0` or `autoReconnect: false` for a connection that may be absent.                                                                                                                                                                    |
| Subscriber mode throws **synchronously**               | A client in subscriber mode rejects data commands with `ERR_REDIS_INVALID_STATE`, thrown synchronously, so `.then(ok, err)` does not catch it. Subscriptions need their own connection.                                                                                                                                                                                                                                                                                                                                 |
| Subscriber mode also leaks past `close()`              | With `maxRetries: 0` against a **healthy** server, a client that ever entered subscriber mode keeps the event loop alive after `close()`. Subscribe then `close()` hung until killed at 10s; publish-only on the same client exited 0. `await client.unsubscribe()` before `close()` fixes it, with a channel or with no arguments. `bun test` hides this, because the runner exits the process itself.                                                                                                                 |
| A **failed** `subscribe()` leaks past `close()` too    | `maxRetries: 0` does not save you. `subscribe()` against an unreachable server rejects with `Max reconnection attempts reached` and then holds the event loop open after `close()`; `unsubscribe()` cannot rescue it, because the client is not in subscriber mode and rejects with `can only be called while in subscriber mode`. A failed `publish()` on the same url releases cleanly. Fix: `await client.connect()` **before** `subscribe()`, which fails first, releases cleanly, and reports `Connection closed`. |
| There is no `url` property                             | `new Bun.RedisClient(url).url` is `undefined`. Anything that reconstructs a client from one it was handed (bullmq's Bun adapter does, for a worker's blocking `duplicate()` and for every reconnect) silently falls back to Bun's default url resolution and connects to a **different server**. `@dunx/infra/queue` hands bullmq a `Bun.RedisClient` subclass carrying the url.                                                                                                                                        |

The subscriber-mode and failed-`subscribe()` leaks were measured on 1.3.14 and
reproduce on 1.4.1; both are fixed in `@dunx/infra/redis`, and catching them needs
a spawned process, which that package's suite has.

Real but missing from `bun-types`: `psubscribe`, `punsubscribe`, `pubsub`, `script`,
`select`, `connected`, `bufferedAmount`, `onclose`, `onconnect`. Of these `pubsub`,
`script` and `select` work and are reachable through `send()`.

### The SIGTERM hang is two leaks, and only one of them is bullmq's

Measured while wiring `@dunx/infra/queue`, then re-bisected a layer at a time. The
earlier entry blamed bullmq for all of it; that was half wrong. Construct, attempt
one operation, tear down, then `SIGTERM` and wait 12 s, with
`connectionTimeout: 2000, maxRetries: 0` throughout:

| server                          | plain `Bun.RedisClient` | `createBunRedisClient` over it | a bullmq `Queue` on it |
| ------------------------------- | ----------------------- | ------------------------------ | ---------------------- |
| healthy `127.0.0.1:6379`        | exits 0 in ~100 ms      | exits 0 in ~100 ms             | exits 0 in ~110 ms     |
| refused `127.0.0.1:6399`        | exits 0 in ~100 ms      | **never exits**                | **never exits**        |
| black-holed `10.255.255.1:6379` | **never exits**         | **never exits**                | **never exits**        |

The black-holed row is Bun's: the pending-connect leak listed under
[Fixed upstream](#fixed-upstream), which 1.4.0 fixed for a plain client. The refused
row is bullmq's: its adapter runs a `setTimeout` reconnect chain, `disconnect()` and
`quit()` both return early when `closed` is already `true` (which is when a
reconnect is pending), and nothing on `IRedisClient` can cancel it. Reproductions
for both are in internal/notes/roadmap/queue-shutdown-sigterm.md.

The healthy row is clean at every layer, so no normal deployment sees this. A
container that touched a Redis it could not reach will not exit on `SIGTERM` and
gets `SIGKILL`ed instead. It serves correctly throughout (the route answers 503 in
single-digit milliseconds), so this is a shutdown defect, not an availability one.

**bullmq 6.0.5 has no `exports` map and no `"type": "module"`, so Bun resolves it to
`main`, the CJS build.** The imported namespace carries `__esModule` and a `default`
holding `Queue`. Both builds statically import `ioredis` and `ioredis/built/utils`,
ioredis 6.0.0 still ships that path, and no pin is needed. Full measurement in
architecture/queues.md, "Not pinning ioredis 5".

### `send(EVAL, ...)` runs Lua atomically, and a Lua table returns as a JS array

Bun exposes no `WATCH`, so this decides any compare-and-set design. One script
returns `[allowed, retryAfterMs, remaining, resetMs]` in a single round trip, so
`@dunx/http`'s throttle store is correct under concurrency without a transaction:
200 parallel `EVAL`s produced 200 unique counter values.

`SCRIPT LOAD` through `send('SCRIPT', ['LOAD', src])` returns a sha, and `EVALSHA`
after a `SCRIPT FLUSH` rejects with a generic `code` carrying `NOSCRIPT` in the
message, so a reload path has to match on the message.

`MULTI`/`EXEC` also work through `send()` and are the wrong tool: auto-pipelining
shares one socket, so transactions from concurrent callers interleave. Costs,
pipelined: `EVAL` full source 19.0 us, `EVALSHA` fixed window 11.2 us, GCRA 9.9 us,
a bare `INCR` floor 2.5 us.

## Files and S3

### `Bun.write` takes a stream, and it is the whole local write path

Since 1.4.1 `Bun.write(path, stream)` streams, truncates a longer existing file,
honours `createPath` in both directions, returns the byte count, and rejects with the
source's own error when the stream fails part way. It leaves the partial file
behind. A 4 MiB multi-chunk stream writes 4194304 bytes. `Bun.write(path, response)`
and `Bun.write(path, request)` with a streaming body settle too:

```
1) write(stream)          -> "hello stream" (12 bytes returned)
2) write(Response(stream))-> settled: 14 "hello response"
2b) write(Request)        -> settled: 13 "hello request"
```

`LocalStorage` is one `Bun.write` call. Through 1.4.0 it had to be an empty
`Bun.write` to create and truncate, then a `FileSink` pumped over the top; the 1.4.0
traps are under [Fixed upstream](#fixed-upstream).

Removing the local caller exposed that `pump` had **never been tested where it
runs**: it read 100% only because `LocalStorage`'s suite shared the helper, and the
S3 upload path it exists for had no test. `s3.test.ts` now has two.

### `Bun.file` / `Bun.write` - `writer()` does not truncate

`Bun.file(path).writer()` writing `"bb"` over a 20-byte file leaves
`bbAAAAAAAAAAAAAAAAAA`, and it does not create parent directories (`ENOENT`).
Reproduced on 1.4.0, 1.4.1 and 1.4.2. Use `Bun.write` locally.

### `Bun.Glob.scan` - `cwd` is where a pattern starts, not a boundary

`scan({ cwd })` resolves the pattern against `cwd` and follows it wherever it leads.
An absolute pattern ignores `cwd` entirely. Measured on 1.4.2 rev `744846f84`, one
run, against a root holding `ok/a.txt` and `sub/s.txt` with a `secret/creds.env`
beside it:

| Pattern              | Yields                                           |
| -------------------- | ------------------------------------------------ |
| `**/*`               | `sub/s.txt`, `ok/a.txt`                          |
| `../secret/*`        | `../secret/creds.env`                            |
| `sub/../../secret/*` | `sub/../../secret/creds.env`                     |
| `/etc/hostn*`        | `/etc/hostname`                                  |
| `{ok,../secret}/*`   | nothing, and that includes the `ok/a.txt` branch |
| `{.,..}/secret/*`    | nothing                                          |
| `[.][.]/secret/*`    | nothing                                          |
| `..?/secret/*`       | nothing                                          |

A `..` segment and a leading `/` escape. The forms that spell a parent segment
without writing one as a segment do not, and a brace group holding a `..` branch
matches nothing at all. `dot: true` and `onlyFiles: true` change none of it. An
escape stays visible in the result: a relative match keeps its `../` prefix and an
absolute pattern yields absolute paths.

`LocalStorage.list` takes its `glob` from a caller, usually a query parameter, so it
checks the pattern through the same `checkWithin` every key goes through and checks
each path the scan produced. The second check keeps containment off the last four
rows: they are today's expansion, not a promise.

That per-entry check costs. 5,000 files under one root, medians of seven runs:

| Listing                      | Median |
| ---------------------------- | ------ |
| `**/*`, every entry checked  | 7.0 ms |
| `**/*`, no entry checked     | 3.7 ms |
| the check alone, 5,000 calls | 1.8 ms |

So it runs only for a pattern carrying `{`, `[`, `(` or a backslash, the characters
that can expand into a segment the pattern check did not see. A wildcard never
matches a separator, so `*`, `**` and `?` cannot spell a parent segment, and extglob
is covered because `@(`, `+(`, `?(` and `!(` all carry a paren. `**/*` pays nothing
and `{a,../b}/*` pays for every entry.

**A backslash is not an escape.** On 1.4.2 it matches a literal backslash in a name:

```
ok/*          -> ["ok/a.txt"]      \o\k/*        -> nothing
dot.dir/*     -> ["dot.dir/f.txt"] dot\.dir/*    -> nothing
\.\./secret/* -> nothing           ..            -> nothing
```

So `\.\./secret/*` looks for a directory named `\.\.`. If Bun ever treats `\.` as an
escaped dot, that pattern becomes `../secret/*` while `hasParentSegment` still sees
`['', '.', '.']`, because it splits on the backslash. Gating on the character costs a
real pattern nothing.

### `Bun.S3Client` - the undocumented surface

`prototype`: `delete`, `exists`, `file`, `list`, `presign`, `size`, `stat`,
`unlink`, `write`. Each also exists as a **static**, taking credentials per call.

`client.file(key)` returns an **`S3File extends Blob`** adding `arrayBuffer`,
`bytes`, `delete`, `exists`, `formData`, `image`, `json`, `lastModified`, `name`,
`size`, `slice`, `stat`, `stream`, `text`, `type`, `unlink`, `write`, `writer`,
`presign`, `bucket`.

- `presign()` is **synchronous and offline**: HMAC over the canonical request.
- `stat()` → `{ size, lastModified: Date, etag, type }`, not an fs `Stats`.
- `write()` accepts `string | ArrayBufferView | ArrayBuffer | Request | Response |
BunFile | S3File | Blob | File | Archive`, and **not** `ReadableStream`, still on
  1.4.1. A streaming upload goes through `file().writer()`, which returns a multipart
  `NetworkSink`, so `S3Storage` keeps that sink and `pump` with it.

### `NetworkSink.end(error)` commits the upload rather than aborting it

Passing an error to `end` is documented as the way to fail a `NetworkSink`. It does
not abort. Measured on 1.4.1 against MinIO, writing one chunk and then erroring the
source:

```
reason            size     rejected with        object after
Error('boom')     7 B      Error: boom          exists, 7 bytes
'failed'          7 B      failed               exists, 7 bytes
Error('boom')     6 MiB    Error: boom          exists, 6291456 bytes
'failed'          6 MiB    failed               exists, 6291456 bytes
```

Both sides of the 5 MiB multipart threshold. **The caller sees a rejection and the
bucket keeps a truncated object**, and nothing in the failure says the key was
written. A `delete` after the failed `end` clears it, so `S3Storage.write` removes
the key on failure and rethrows the source's own error.

**A failed replacement destroys the previous version too, inside the sink.** A
24-byte object overwritten by a stream that dies after 7 bytes is a 7-byte object
before any cleanup runs, at both sizes. So the choice is between absent and silently
truncated; the original is gone either way. Preserving it would need a temporary key
and a publish step, and `Bun.S3Client` exposes no server-side copy.

### `Bun.S3Client` reads `S3_ENDPOINT` for every client that sets none

`S3StorageOptions` passes its options straight through, and anything omitted falls
back to the environment. Exporting `S3_ENDPOINT` to point the live
`@dunx/infra/files` suite at MinIO made the offline `presign` suite, which sets
explicit fake credentials and region but no endpoint, sign URLs against
`localhost:9000` and fail its assertions on `s3.eu-west-1.amazonaws.com`.

The live block takes `DUNX_S3_TEST_ENDPOINT` instead and passes it explicitly, so the
endpoint reaches one client. Credentials can stay ambient: those tests set theirs,
so `AWS_ACCESS_KEY_ID` changes nothing. Against MinIO the suite passes as written,
no path-style flag needed, and `files/s3.ts` goes from 35.1% lines to 87.8% on one
round-trip test.

## Image

### `Bun.Image`

Fully typed in `bun-types` (`bun.d.ts` ~8180-8408) and barely documented on the
site. Construction is `new Bun.Image(source)`; `await new Bun.Image(buffer).metadata()`
reads dimensions off an upload and replaces an `image-size` dependency outright.

- **statics**: `backend`, `fromClipboard`, `hasClipboardImage`, `clipboardChangeCount`
- **metadata / dimensions**: `metadata()`, `width`, `height`
- **transforms**: `resize`, `rotate`, `flip`, `flop`, `modulate`
- **encoders**: `png`, `jpeg`, `webp`, `avif`, `heic`
- **outputs**: `blob`, `buffer`, `bytes`, `dataurl`, `toBase64`, `toBuffer`, `write`
- **other**: `placeholder`

Behaviour:

- **Lazy and re-runnable.** Chainables only record; the pipeline runs on a worker
  when a terminal is awaited. A second terminal on the same instance re-runs it.
- **Chainables mutate and return `this`, and overwrite.** `.resize(10,10).resize(20,20)`
  yields 20×20. Execution order is fixed at
  `autoOrient → rotate → flip/flop → resize → modulate` regardless of call order. A
  shared instance lets one caller silently reconfigure another's transform, so a
  wrapper should be immutable.
- **`metadata()` ignores the chain** and only reads the header, so it reports the
  _source_ dimensions and format. It succeeds on a truncated file, so it is **not** a
  validity check.
- **`width`/`height` are `-1`** until a terminal has been awaited, then hold whatever
  that terminal produced.
- **Decode-only formats do not round-trip.** The types claim a terminal with no
  format setter re-encodes in the source format; for `gif`/`bmp`/`tiff` it emits
  **PNG**.
- **`placeholder()` also ignores the chain**: always a ThumbHash of the source.
- Silent clamping, no throw: `resize(0)`, `resize(-5)`, `resize(1.5)` → 1×1;
  `quality` outside 0-100 is clamped. Unknown option _keys_ are ignored, unknown
  `filter` _values_ throw.
- Errors are plain `Error` + `error.code` (`ERR_IMAGE_UNKNOWN_FORMAT`,
  `ERR_IMAGE_DECODE_FAILED`, `ERR_IMAGE_FORMAT_UNSUPPORTED`,
  `ERR_IMAGE_TOO_MANY_PIXELS`), except argument validation, which is `TypeError`.
- **Undocumented but present:** `Bun.file(p).image()` and `Blob.prototype.image()`;
  a `data:` URL is accepted as input; `linear` is a valid resize filter though the
  error message listing valid names omits it. An `http(s)://` string is **not**
  fetched; it is treated as a path.
- On Linux `backend` is `'bun'`, HEIC/AVIF **encode** is unsupported, `tiff` decode
  fails, and the clipboard statics are inert.
- **CMYK JPEGs decode from 1.4.2.** A 64x48 CMYK JPEG through `resize(32, 24).webp()`
  gives 82 bytes of webp; on 1.4.1, still inside the `engines` floor, it fails with
  `Image: decode failed (ERR_IMAGE_DECODE_FAILED)`. `metadata()` reports `64x48 jpeg`
  on both, since it reads only the header.

## Scheduling and timers

### `Bun.cron` - 1.4 honours `{ tz }` and changed the default zone

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

**The default flip silently moves any caller that omitted `tz`.** A nightly
`'0 3 * * *'` fired at 03:00 UTC on 1.3 and fires at 03:00 local on 1.4.
`@dunx/infra/schedule` passes `tz` on every call and defaults it to `'UTC'`, so no
dunx schedule moves; a direct `Bun.cron` caller has to pass it.

`packages/infra/src/schedule/bun-cron.ts` existed only to cast around the missing
declaration and is deleted; the call sites use `Bun.cron` and `Bun.cron.parse`
directly. `supportsTz()` stays: the probe tells a 1.3 runtime from a 1.4 one without
reading `Bun.version`.

### An over-large timer is clamped to 1 ms

Exactly as Node clamps it, on 1.4.0: `setTimeout(fn, 2**31)`, `2**31 + 1`, `1e15`
and `-1` each emit `TimeoutOverflowWarning` or `TimeoutNegativeWarning`, are set to
**1 ms**, and fired **17 ms** after arming. An `@Interval` above 2147483647 ms would
be a silent hot loop, so `@dunx/infra/schedule` rejects one at boot and points at
`@Cron`. `Timer` objects carry `ref`, `unref` and `hasRef`.

### `setTimeout(...).unref()` - the semantics a forced exit depends on

Bun implements Node's timer `unref()`, and it behaves as a graceful-shutdown guard
needs. Probed on 1.3.14:

```
armed unref timer; nothing else holding the loop
exited naturally after 1ms                  <- callback never ran

UNREF FIRED after 503ms while server held the loop
exit=7                                      <- callback ran, process.exit took effect
```

Both properties are load bearing for `ShutdownHooks`
(`packages/core/src/di/shutdown-hooks.ts`):

- An unref'd timer **cannot keep the process alive**. With nothing else pending the
  runtime exits at once and the callback never runs, so arming one costs a clean
  shutdown nothing.
- It still **fires on schedule when something else holds the loop open**, and
  `process.exit(code)` inside it takes effect.

So a shutdown hook can end the process only if it was not going to end anyway,
without a race or a fixed delay. A ref'd timer would add its own delay to every
clean exit, and polling would need a loop that is itself a handle.

## Process, stdin and TTY

### One line of stdin keeps the process alive

`console` is async-iterable over stdin's lines. Taking one line with `.next()` and
stopping there leaves the handle referenced for the life of the process. Probed on
1.4.0, one line written into a stdin the parent holds open:

```
console[Symbol.asyncIterator]().next()         still running after 6s     <- HANG
for await (const line of console) { break }    exited after 0.02s
for await (const line of console) { return }   exited after 0.02s
process.stdin.unref() after .next()            exited after 0.02s
process.stdin.pause() after .next()            exited after 0.02s
Bun.stdin.stream() reader, then cancel()       exited after 0.02s
```

Ending the iteration releases it: `break` and `return` both run the iterator's
`return()`, and the three explicit calls do the same by hand.

**A piped test never sees this.** `printf 'notes\n' | bun cli.ts` closes stdin at
once, the iteration ends on EOF, and the process exits. The hang needs something
holding the other end open, and every real terminal does. That is how it reached a
release: `bunx @dunx/create-app my-api` wrote the app, printed its next steps, and
sat there until Ctrl+C, after the piped CLI suite had been green for weeks.

`@dunx/create-app` reads keys in raw mode now, and `ProcessTty.close()` in
`tools/create-app/src/tty.ts` is the same release by hand. The rule outlives the
call: **a read of stdin that is not ended holds the process open**, whatever API
opened it.

### Raw-mode stdin, and driving it from a test with `Bun.Terminal`

Probed on 1.4.0, because `@dunx/create-app` asks its questions with an arrow-key
list. Five facts, all load bearing for `tools/create-app/src/tty.ts`:

```
process.stdin.setRawMode              undefined on a pipe, a function on a TTY
arrow key, raw mode on                one chunk: 1b 5b 41
Ctrl+C, raw mode on                   one chunk: 03      no SIGINT handler fired
off('data') + setRawMode(false) + pause()      exited 0, no process.exit() needed
write('a\nb\n') while raw            arrives as a<CR><LF>b<CR><LF>
```

- **`setRawMode` is absent, not failing, on a pipe.** Checking `isTTY` on both
  streams is the capability test; there is nothing to catch.
- **An escape sequence arrives whole.** Three bytes arrive in one read, so a decoder
  can treat a chunk holding nothing but `0x1b` as the Escape key without a timer.
- **`ISIG` is off, so Ctrl+C is a byte.** A `SIGINT` handler installed alongside
  never ran, so the cancel path exits 130 itself.
- **Restoring is enough to exit.** No `process.exit`, no `unref`.
- **`OPOST` and `ONLCR` survive raw mode**, so a frame written with `\n` still
  returns the carriage. Node's `setRawMode` only clears input and local flags.

**`Bun.spawn(cmd, { terminal })` is a real PTY**: the child reports
`isTTY === true`, gets the `cols`/`rows` the parent declared, and reads keys the
parent writes with `terminal.write()`. So `interactive.test.ts` answers the CLI's
prompts the way a person does, with no `node-pty` and no browser.

```ts
await using terminal = new Bun.Terminal({ cols: 100, rows: 30, data(_t, bytes) { … } });
const proc = Bun.spawn(['bun', CLI, 'billing'], { cwd, terminal });
terminal.write('\u001b[B');
```

- The `data` callback receives the **stream**, not a rendered screen: every repaint
  is in there. Assert on the last frame, or on a substring only the state under test
  produces.
- `exit` on `TerminalOptions` is the **PTY's** lifecycle. The child's code comes from
  `subprocess.exited`.

A spawned process reports no coverage, so the classes underneath take a stream pair
as constructor arguments and the suite drives them in-process. The PTY suite answers
what a fake cannot: whether a real terminal behaves the way the fake assumes.

### `Bun.color` - `'ansi'` is not a fixed encoding

`Bun.color(hex, 'ansi')` returns whatever the _current terminal_ is judged to
support, not a stable format, so a log formatter should name the encoding it wants.
On 1.4.0:

```
FORCE_COLOR=1  Bun.color('#00ff00', 'ansi')     -> "\u001b[92m"
FORCE_COLOR=1  Bun.color('#00ff00', 'ansi-256') -> "\u001b[38;5;46m"
NO_COLOR=1     Bun.color('#00ff00', 'ansi')     -> ""   (Bun.enableANSIColors === false)
```

Ask for **`'ansi-256'`** explicitly: it pins the encoding rather than letting the
terminal pick. On 1.3.14 this was also a corruption (see
[Fixed upstream](#fixed-upstream)); on 1.4 it is a determinism argument.

`Bun.enableANSIColors` is the honest capability check. It is `false` under
`NO_COLOR` and for a non-TTY, and it cannot be faked in-process, so testing
degradation needs a real subprocess with stdout piped.

## AsyncLocalStorage and tracing

### A nested `AsyncLocalStorage.run()` held the enclosing store

`AsyncRequestContext.runWithContext` reads the enclosing store and calls
`storage.run` with a merge of it, so every scope after the outermost is a nested
`run()`. On 1.4.1 a timer, immediate or pending promise opened inside one kept the
**outer** store alive for as long as it existed. `getStore()` returned the right
value throughout, so retention was the only symptom. Probed with a `WeakRef` to the
outer store, a one-hour timer opened inside the nested scope, and `Bun.gc(true)`:

```
1.4.1  nested run(): RETAINED    exit(): RETAINED
1.4.2  nested run(): collected   exit(): collected
```

In dunx that object is a request's `RequestFields`, held by whatever the handler
left pending. 1.4.1 is inside the `engines` floor, so it still leaks there.

The fix costs at scope entry, which `runWithContext` pays at least once per request.
Nine interleaved rounds of 50,000 iterations, medians:

| Step                          | 1.4.1   | 1.4.2   |
| ----------------------------- | ------- | ------- |
| `als.run(v, fn)`, synchronous | 11.4 ns | 15.6 ns |
| three nested `run()`s         | 42.1 ns | 59.2 ns |
| store cost across 16 awaits   | 14.9 ns | 15.3 ns |

Entry moved +4 ns for one scope and +17 ns across three, against the 47.2 ns per
scope `AsyncRequestContext` records and a request measured in microseconds. No
published figure moves.

### `AsyncLocalStorage` stopped charging per `await`, and the ladder cannot see it

1.4.1 claims `run()` is about 2x faster and that "an active store no longer costs an
extra allocation on every await". The second half matters here, because
`RequestContext` holds a store across a whole handler. Timing the same body with and
without a store around it:

```
        1.4.0                        1.4.1
awaits  store cost   per await       store cost   per await
     1       12.20       12.20             9.34        9.34
     2       17.01        8.51             9.34        4.67
     4       30.49        7.62             8.83        2.21
     8       51.95        6.49             8.46        1.06
    16      103.60        6.48             5.44        0.34
```

**On 1.4.0 the store cost ~6.5 ns per `await`. On 1.4.1 it is a flat ~9 ns entry
cost**, so sixteen awaits pay 5.44 ns instead of 103.60. Synchronous
`als.run(v, fn)` went 11.10 ns to 9.54 ns, three nested `run()`s 35.21 to 34.22.
1.4.2 keeps the flat cost (about 1 ns per await across sixteen) and moves entry, as
above.

**`bun run logging` cannot resolve this.** Its `als` row adds `runWithContext` around
a handler with one await, where the saving is about 3 ns against a step the harness
measures at 240 to 560 ns with a standard deviation larger than the effect. Five
focused rows, five runs: `als - trace` came out **+0.27 µs** against +0.24 µs on
1.4.0. The full ladder in the same session read +0.56 µs for the same step and put
`respheader` above `entry`, its known behaviour at this resolution. **No recorded
logging figure moves.**

### `AsyncLocalStorage.enterWith()` works on 1.4, and is still the wrong call

On 1.4 `enterWith(1)` followed by `await Promise.resolve()` reads back `1` (on
1.3.14 it segfaulted; see [Fixed upstream](#fixed-upstream)). An earlier note said a
working `enterWith` would be worth adopting against a measured `run()` cost of
+0.91 us. Re-measured over 200,000 iterations of a request-logging shape (enter a
scope carrying five fields, await, read one back):

| form                              | per scope |
| --------------------------------- | --------- |
| `run(fresh, async cb)`            | 0.168 us  |
| `enterWith(fresh)` then the await | 0.151 us  |
| no store at all, the floor        | 0.097 us  |

**The saving is 0.017 us**, a fifth of what the store costs and about 2% of the
+0.91 us that was the whole case for the swap.

The semantics settle it independently: `enterWith` cannot restore the enclosing
store on the way out, so an `enterWith` inside a scope leaves the outer scope
reading the inner value forever. `RequestContext.runWithContext` is specified to
merge and not leak back out, so it cannot be built on `enterWith`:

```
run():       outer -> nested run()       -> outer sees "outer"
run():       outer -> nested enterWith() -> outer sees "clobbered"
```

`AsyncRequestContext` and `@arkv/logger` keep `run()`. `bun run logging` on 1.4
prices the whole scope in request logging at **+0.24 us**, down from +0.91 us and
inside that harness's +/-0.5 us floor. **Do not reopen this on the segfault being
fixed; both measurements were taken after the fix.**

### OpenTelemetry on 1.4 - `require` only, and it never sees `Bun.serve`

Probed with `@opentelemetry/sdk-node` (73 packages), `instrumentation-http` and an
`InMemorySpanExporter`, everything under `bun --preload`:

| Entry path                                   | Spans                                         |
| -------------------------------------------- | --------------------------------------------- |
| `require('node:http')` server and `http.get` | 2 - a server span and a client span           |
| `import('node:http')`, identical requests    | none, and `http.get.__wrapped` is `undefined` |
| `Bun.serve` inbound                          | none                                          |
| global `fetch` outbound                      | none                                          |

`require-in-the-middle` hooks `require`, and an ESM import of a `node:` builtin does
not go through it, so a preloaded SDK patches nothing unless the file importing
`node:http` is CJS. Re-probed on **1.4.2** with `getNodeAutoInstrumentations()`:
nothing moved. A CJS `require('node:http')` still records **2** spans with
`http.get.__wrapped` true, an ESM `import` **0**, and `Bun.serve`, `fetch` and
`bun:sqlite` in one process **0** between them.

`startActiveSpan` holds context across an `await`, and a child started after it
carries the parent's trace id and span id (`@opentelemetry/context-async-hooks` over
`AsyncLocalStorage`). For dunx the auto-instrumentation sees none of `Bun.serve`,
`fetch`, `Bun.RedisClient` or `Bun.SQL`. Tracing here means spans dunx emits against
`@opentelemetry/api` at the seams it owns: the request middleware, the job
processor, the Redis wrapper.

#### The propagation half does work, and dunx interoperates with it

Probed on 1.4.0 with `@opentelemetry/api` 1.9.1, `sdk-trace-node` 2.11.0 and
`W3CTraceContextPropagator`. Every result is asserted by
`packages/http/src/server/otel-interop.test.ts` against a real `Bun.serve`:

| Probe                                           | Result                                            |
| ----------------------------------------------- | ------------------------------------------------- |
| `NodeTracerProvider.register()` and `startSpan` | works; spans reach an `InMemorySpanExporter`      |
| `propagation.inject`                            | emits `00-<32 hex>-<16 hex>-01`                   |
| `propagation.extract` of a header dunx wrote    | yields a span context with `isRemote: true`       |
| a child span started from that context          | joins the trace, dunx's span as `parentSpanId`    |
| `context.with(...)` across an `await Bun.sleep` | survives                                          |
| all-zero trace id                               | the SDK rejects it too - `getSpanContext` is void |

The SDK and `TraceContext` agree on the wire in both directions with no adapter.
There is **no** `Bun.*` or `bun:*` trace API on 1.4.0: `Bun` and `globalThis` have
no trace-ish key, and `bun:otel`, `bun:telemetry` and `bun:trace` do not resolve.
`node:diagnostics_channel` exists, including `tracingChannel`.

### `Uint8Array.prototype.toHex` exists and is the fastest hex on 1.4

TC39 `Uint8Array` base16, with `fromHex` alongside, and it typechecks under the root
tsconfig's `lib: ESNext` with no cast.

```text
crypto.randomUUID().replaceAll('-','')          223.4 ns
Buffer.from(getRandomValues(16)).toString('hex') 112.6 ns
getRandomValues(24) -> toHex + 2 slices           49.2 ns
```

Minting a W3C trace id and span id together is 49.2 ns, against 260.5 ns for the
`crypto.randomUUID()` path it replaced.

## Test runner

### `bun test --parallel` is 4.6x, and changes two things

Probed on 1.4.0, 32 cores. The whole `./packages ./tools ./scripts` sweep, 1,663
tests across 140 files: **3.16s with `--parallel`, 14.56s without**.
`packages/http` alone is 3.03s against 6.70s. One module registry per worker, N
workers, N defaulting to the core count.

**A `?raw` import suffix does not survive a worker.** `internal/docs/src/data.ts` has
`import indexRaw from './generated/index.json?raw'`. In one process that import is
the file's text; in a `--parallel` worker it is the parsed object, so `JSON.parse`
throws `SyntaxError: JSON Parse error: Unexpected identifier "object"` and 7 of the
suite's 10 files bail: **91 tests sequentially against 30 passing and 7 failing**.
It fails loudly, so opting in per workspace is safe. `internal/docs` is the one
exclusion, in the `docs` phase of `scripts/ci.ts`. Reproduces on 1.4.1, and on 1.4.2
38 of 92 fail.

**The runtime transpiler cache serves a stale `?raw` module.** That import is 69 KB,
over the 50 KB the cache starts at, so `bun run generate` then `bun test src` in the
same checkout reads the **previous** model: 26 guides from `data.ts` and 27 from the
same specifier imported directly in the test file, in one process. `links.test.tsx`
then reports a link to the new page as pointing at nothing.
`BUN_RUNTIME_TRANSPILER_CACHE_PATH=0` disables the cache and both read 27. CI is a
fresh runner, so it sees this only if a job regenerates the model after its first
read. Reproduces on 1.4.1.

`packages/infra` is 538 pass sequentially against 543 under `--parallel`, with the
same 5 skips, and it is not a bug: `describe.if(live)` in `queue/worker.test.ts` and
`redis/client.test.ts` gates on a reachability probe and each worker probes for
itself. The distinct test names are identical, 536 either way.

Undocumented flags: `--shard=1/3` splits files across jobs, `--timings <file>` plus
`--update-timings` writes per-file durations and balances shards by them, and
`--dots` cuts the reporter to a character per file.

### `--coverage --parallel` agrees with sequential

Since 1.4.1, so the `coverage` phase of `scripts/ci.ts` runs `--parallel`. The whole
`./packages ./tools ./scripts` sweep, 170 files:

```
sequential  91.11 funcs / 95.30 lines   13.5s
parallel 1  91.11 funcs / 95.30 lines    2.6s
parallel 2  91.11 funcs / 95.30 lines
parallel 3  91.11 funcs / 95.30 lines
```

The per-package model `scripts/coverage-report.ts` builds is identical for all ten
workspaces, on lines and on functions. The `lcov.info` files differ in hit counts and
file order; the percentages derived from them do not. On 1.4.0 the same sweep read
87.21/88.52, then 87.10/88.23, then 87.24/88.27 against a sequential 87.80/93.92:
functions about 5.5 points under, and different each run.

### `--parallel` implies `--isolate`, and `--isolate` re-runs a shared test module

`bun test --help` states it: `--parallel` implies `--isolate`, and `--no-isolate`
opts back out. So the `unit` phase has been isolating since `--parallel` was adopted.

Adding `--isolate` to the then-sequential `coverage` phase, measured on 1.4.0 over
160 files:

- **16.6s to 17.9s**, about 8%.
- **1874 tests become 1879.** The five are one test run five times. It is declared in
  `packages/infra/src/images/fixture.test.ts`, which five other test files import for
  its exported sources. A fresh registry per file re-evaluates that module per
  importer, so its own `it()` re-registers each time.

A shared module that exports fixtures and also declares tests triggers it. The name
has to end in `.test.ts` for `coverageSkipTestFiles` to drop it, so the combination
is not easily avoided here.

### `--timings` cannot beat the slowest single file

`--timings=<file>` plus `--update-timings` makes `--parallel` start the slowest file
first. Three runs each: 3.12-3.17s with, 3.13-3.16s without. The slowest test file is
3045 ms of a 21161 ms total across 160 files, and the wall clock is ~3150 ms, so the
run is already bounded by that one file. `--shard` is bounded by the same file.
Worth re-measuring only if that file gets faster or another gets slower.

### `--coverage-reporter` on the command line does not override bunfig

`coverageReporter = ["text", "lcov"]` in the root `bunfig.toml` wins over
`bun test --coverage --coverage-reporter=lcov`: the per-file text report prints
either way (4 table rows both ways from the repo root). From inside a package it looks
like it works, because Bun reads the `bunfig.toml` beside the working directory and
`packages/*` have none. `scripts/ci.ts` prints a tail of the step's output instead,
the table rather than the 370 lines of per-file report ahead of it.

**`bun test` writes its report to stderr**, and a script's own `console.log` goes to
stdout. Concatenating the two pipes put `bun run test:cov`'s coverage table 370 lines
_above_ the run that produced it, so `scripts/ci.ts` drains both into one buffer as
the chunks arrive.

### Three things `bun test --coverage` counts that no test can reach

Chasing a 90% floor turned up measurement artifacts, so these are what the floor is
set against.

**Type-only lines count against you, through the sourcemap.** A subject with one
import, two interfaces, an abstract class and one implementation, and a test calling
every method:

```
                                LF   LH    lines
default (remap to source)       28   11    39.3%
coverageIgnoreSourcemaps = true 17   15    88.2%
```

The unreachable lines are the `import`, the interface members and the abstract
member signatures, none of which emit anything.
`packages/core/src/logger/context.ts` read 32.35% (`DA:1,0` through `DA:46,0` over
its imports and interfaces) for a class exercised on every boot. Repo-wide the
remapping costs about 1.8 points: 93.55% against 95.33%.
`coverageIgnoreSourcemaps = true` is **not** set: the uncovered ranges the coverage
page lists would become transpiled line numbers, pointing at nothing a reader can
open.

**A class with no explicit constructor is an unhit function.** Probed one construct
at a time:

```
abstract class, 1 abstract member          FNF:1 FNH:0
abstract class, 3 abstract members          FNF:1 FNH:0
abstract class, 1 member, 3 overloads       FNF:1 FNH:0
abstract class, abstract getter             FNF:1 FNH:0
abstract class, abstract field              FNF:1 FNH:0
abstract class, no members at all           FNF:1 FNH:0
interface with two methods                  FNF:0 FNH:0

class with an implicit constructor, instantiated and called   FNF:2 FNH:1
class with `constructor() {}`, instantiated and called        FNF:2 FNH:2
```

An implicit constructor is counted and never marked hit, even when `new C()` runs;
abstract classes show up because they rarely declare one. The counts do not add up at
scale (`@dunx/core` has 15 unhit functions against roughly 43 classes with no explicit
constructor), so **do not subtract this from the denominator**: a correction built on
a rule this shaky would be baked into the gate.

Also unreachable: `di/scope.ts:289` is a throw its own comment calls unreachable, and
`di/shutdown-hooks.ts:86-92` is covered by a test that **spawns** a process, which
the parent's coverage run cannot see into.

**Bun's lcov carries no per-function records**: `FNF` and `FNH` counts only, no `FN:`
or `FNDA:` lines, so finding a missed function means reading `DA:` ranges.

A `*.fixture.ts` is counted like shipped code: `coverageSkipTestFiles` drops
`*.test.ts` and stops there. `tools/mcp/src/app.fixture.ts`, with 16 decorated
handlers nothing calls, held `@dunx/mcp` at 76.62% functions;
`coveragePathIgnorePatterns` now covers `**/*.fixture.ts` and it reads 96.4%.

### `expect(...).rejects` returns `undefined`, so the `await` is a no-op

`bun-types` declares every matcher `: void` and `rejects: Matchers<unknown>`, and the
runtime agrees: `expect(Promise.reject(x)).rejects.toThrow()` evaluates to
`undefined`. `await expect(...).rejects.toThrow()` awaits nothing;
`typescript/await-thenable` fires on that at 19 sites here.

The assertion holds without the `await`. All four combinations (settled or pending,
correct or wrong expectation, awaited or not): Bun tracks the assertion against the
running test and fails it either way, taking 5.53 ms for a promise that settles after
5 ms. The `await`s stay, as the form Jest and Vitest readers expect and the only one
that still asserts if Bun makes these matchers return a promise.
`typescript/await-thenable` is `off` for `**/*.test.ts` and `**/*.test.tsx` in
`.oxlintrc.json`.

### `render()` has no auto-cleanup under `bun test`

`@testing-library/react` registers its own `afterEach(cleanup)` only when it finds
Jest's globals, and it does not find them here. Nothing in `internal/docs` called
`cleanup`, so `useRoute`'s `hashchange` listener outlived each test, and `mount()`
setting `window.location.hash` re-rendered every detached tree earlier files had left.
`symbol-anchor.test.tsx` measured **1.7s alone and 12.5s behind the other nine**
(the `--timings` output put it at 13,069 ms of a 17.4s suite).

`afterEach(cleanup)` registered from the **preload** fixes it, and a preload-registered
hook runs for every test in every file (probed). The suite went from 16,645 ms to
3,683 ms: `site` 1,701 to 1,103 ms, `links` 437 to 25 ms, `releases` 511 to 255 ms.

### `Bun.WebView` - a headless browser in the runtime, and one trap

`Bun.WebView` on 1.4.0, capital V, marked experimental. `WKWebView` on macOS; on
Linux and Windows it drives an installed Chrome, Chromium, Edge or Brave over CDP and
falls back to Playwright's `chrome-headless-shell` cache. GitHub's `ubuntu-latest`
ships Chrome.

The prototype carries `navigate`, `evaluate`, `screenshot`, `cdp`, `click`, `type`,
`press`, `scroll`, `scrollTo`, `resize`, `goBack`, `goForward`, `reload`, `close`,
`url`, `title`, `loading`, `onNavigated`, `onNavigationFailed`. Input dispatches
native events (`isTrusted: true`). `screenshot()` resolves to a **`Blob`**. Against
the built site in `internal/docs/dist`: navigate, read the `h1` and take a 1440x900
screenshot in **526 ms**, 183,085 bytes of PNG.

**`navigate()` never resolves when only the hash changes.** Set the hash from inside
the page and poll for the heading instead:

```ts
await view.evaluate(`location.hash = ${JSON.stringify(hash)}`);
```

Six routes then render in **719 ms**. `await using` disposes cleanly and one view
survives repeated `navigate` calls to distinct URLs.

### Driving a browser from `bun test`: two things in the way

`internal/docs/browser/site.browser.test.ts` needs `Bun.serve` and `Bun.WebView` in
the `bun test` process.

**happy-dom's registrator replaces the global `Response`, and `Bun.serve` refuses
its own handler's return value.** With `happydom.ts` preloaded the server answers
`Expected a Response object, but received 'Response { ... }'` for every request.
`bun test -c other-bunfig.toml` still ran the preload, and
`GlobalRegistrator.unregister()` in a `beforeAll` does not restore the native
`Response`. **A `bunfig.toml` next to the working directory** works: the suite lives
in `browser/` with an empty `[test]`, and its script does `cd browser && bun test`.

**`Bun.WebView` has no `colorScheme` or `deviceScaleFactor` option.**
`ConstructorOptions` is `width`, `height`, `headless`, `backend`, `url`, `console`,
`dataStore`. Both come from CDP after one `navigate`:

```ts
await view.cdp('Emulation.setEmulatedMedia', {
  features: [{ name: 'prefers-color-scheme', value: 'dark' }],
});
await view.cdp('Emulation.setDeviceMetricsOverride', {
  width,
  height,
  deviceScaleFactor: 2,
  mobile: false,
});
```

The body background goes `rgb(255, 255, 255)` to `rgb(36, 36, 36)`,
`devicePixelRatio` reads 2, and the PNG comes out 2880x1800 for a 1440x900 viewport.
The `console` option is a `(type, ...args) => void` callback, which catches a
page-side error no happy-dom test can see. Both emulations are per-target and survive
a navigation; re-applying one already in force would spend 4.2s across 28 shots on
repaint waits. 29 tests over 7 routes, 2 viewports and 2 schemes, writing 28 PNGs,
take 15.4s, against a playwright install that was 150 MB of browser.

## Decorators, transpiler and plugins

### Decorators - a compound assignment to a private field is a `SyntaxError`

**Bun refuses to parse a class that has both a decorated member and a
read-modify-write on a private field.** Measured on 1.4.0 and still on 1.4.2. The
whole file fails at load:

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

- **The class is poisoned, not the decorated method.** A compound assignment in the
  constructor, or in an undecorated private method, fails the same.
- **Only the read-modify-write forms.** `this.#n = this.#n + 1` is the mechanical
  workaround; `Gauge` from `@dunx/core` is the other, and `ChatGateway` uses it.
- Nothing to do with `@dunx/transform`: reproduced in `/tmp` with no preload, no
  `bunfig.toml` and a two-line local decorator.

Every controller, gateway, `@JobHandler` and scheduled service is a decorated class,
and `#count++` is the obvious counter. `this.#x ??= ...` is also how shipped classes
do lazy init: `Application`, `HttpApplication`, `DashboardMiddleware`, `RedisRelay`,
`PostgresRelay`, `JobProcessor`, `QueueConsumer`, `AmqpSubscriber`, `Workspace`. None
is decorated today. Adding one decorator to any of them turns the file into a parse
error whose message names neither the field nor the decorator.

Found writing `examples/full/src/schedule/maintenance.service.ts`, whose
`@Cron`/`@Interval`/`@OnceOnBoot` handlers each incremented a private counter, and
hit again on 1.4.2 by writing `this.#inFlight += 1` in a class with a decorated
method.

### A runtime `onLoad` plugin drops the file it loads - unless Bun reads it

**`bun --watch` and `bun --hot` do not restart on a change to any file a runtime
`onLoad` plugin read with `Bun.file`.** Since `@dunx/transform/preload` handles every
`.ts` and `.tsx`, `bun run dev` restarted on a change to the entrypoint only, in
every dunx app. **Fixed** in `plugin.ts` by reading through Bun's own loader:

```ts
const module = await import(`${path}?`, { with: { type: 'text' } });
return module.default;
```

The file then enters the module graph, so Bun watches it. The `?` is required:
without it the specifier still ends in `.ts` and re-enters the same plugin. From
https://github.com/oven-sh/bun/issues/4689. Measured on 1.4.0, same entry and file,
varying only how the plugin reads:

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

- **The transform was never the cause.** Returning the file byte for byte broke the
  watcher identically; reading it behind Bun's back did it.
- **The obvious repairs are dead ends.** Returning `undefined` to decline is a
  `TypeError`; `watchFiles` is accepted and ignored; and `filter` is a path regex, so
  it cannot skip a file whose contents decide whether the transform applies.
- **The fix is free.** `examples/full` boots in 353-365 ms through `import` against
  354-374 ms with `Bun.file`, 135 MB RSS either way, three runs each.
- Bun watches the entrypoint before any plugin is involved, which is why it alone
  restarted.

`--hot` is no different from `--watch` here, and an **mtime-only `touch` does not
restart Bun**: it needs a write event, so rewriting with byte-identical content
restarts it. `packages/transform/src/watch.test.ts` spawns a real watch and edits a
real import; it times out if the read goes back to `Bun.file`. Found from a report
that editing a `@JobHandler` did nothing; the forked child looked like the cause and
was not.

### The transpiler cache is content-keyed across paths, and a docs failure it did not cause

Three concurrent worktrees under `.claude/worktrees/` each had `internal/docs` tests
load a **sibling worktree's** `generated/index.json`: one failing run's model was
72,727 bytes, byte for byte a sibling's file, carrying a guide absent from the tree
under test. Touching `internal/docs/src/data.ts` by one byte cleared it every time.

The obvious explanation is wrong. `data.ts` pulls its model in with `?raw`, and the
cache under `~/.bun/install/cache/@t@` is keyed by source content rather than path.
Measured on 1.4.2, two directories holding a byte-identical 101,889 byte `data.ts`,
each importing its own `./gen.json?raw`:

| Step               | Piles in `@t@` | Reports |
| ------------------ | -------------: | ------- |
| after running `a/` |  1254 (**+1**) | `AAA`   |
| after running `b/` |  1254 (**+0**) | `BBB`   |

`b` wrote no new entry, so it hit `a`'s: the key is content. It still read its own
JSON, so the shared artifact does not carry the `?raw` payload. And at 4,664 bytes
the real `data.ts` is under the size that writes a pile at all.

`BUN_RUNTIME_TRANSPILER_CACHE_PATH=0` disables the cache; `BUN_RUNTIME_TRANSPILER_CACHE_DIR`
is not a variable Bun reads. The override is also the workaround: a fourth worktree
hit the failure and `BUN_RUNTIME_TRANSPILER_CACHE_PATH=0` cleared it, 28/28. So the
cache is implicated, the mechanism is not known, and the stale module is
unidentified: the threshold sits between 74 bytes and 101,889, and neither a small
importer nor a 70 KB `?raw` target writes a pile. It needs concurrent checkouts,
which a CI run does not have.

## Fixed upstream

Fixed in a Bun release, and no longer driving any dunx code. Kept so the history is
not rediscovered.

| Finding                                                           | Broken on     | Fixed in | Detail                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ----------------------------------------------------------------- | ------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Bun.write(path, readableStream)` writes the wrong bytes          | through 1.4.0 | 1.4.1    | Matched no overload, so the stream was stringified: the file held the 23 bytes `[object ReadableStream]`, with no error.                                                                                                                                                                                                                                                                                                     |
| `Bun.write(path, new Response(stream))` never settles             | through 1.4.0 | 1.4.1    | Hung past a 2.5s timeout with a streaming body; `new Response('plain')` settled. A streaming write had to go through a `FileSink`, preceded by an empty `Bun.write` to create parents and truncate.                                                                                                                                                                                                                          |
| `server.upgrade()` after an `await` leaks an HTTP/1.0 socket      | 1.4.0 only    | 1.4.1    | `@dunx/http`'s `upgradeHandler` goes async when `@OnUpgrade` returns a promise. An HTTP/1.0 request with `Connection: Upgrade` then leaked the socket, so `server.stop(true)` returned and the process never exited. HTTP/1.1 with `Upgrade`, `keep-alive` or `close`, and every synchronous upgrade, exited on both; all four answered `101`. `engines.bun` is `>=1.4.1` partly for this.                                   |
| `AsyncLocalStorage.enterWith()` segfaults after an `await`        | 1.3.14        | 1.4.0    | `als.enterWith(1); await Promise.resolve();` gave `panic(main thread): Segmentation fault`. dunx never adopted `enterWith`; see [the 1.4 measurement](#asynclocalstorageenterwith-works-on-14-and-is-still-the-wrong-call).                                                                                                                                                                                                  |
| A Redis connect that never completes outlives `close()`           | 1.3.14        | 1.4.0    | Against a dropped SYN (`10.255.255.1:6379`), one `send()` rejected on `connectionTimeout` and the process never exited, unmoved by `maxRetries: 0`, `autoReconnect: false`, `enableOfflineQueue: false`, a shorter timeout, double close, closing mid-connect, or waiting 6s. A refused connection was clean. 1.4.0 exits 0 one `connectionTimeout` after the attempt. See internal/notes/roadmap/queue-shutdown-sigterm.md. |
| `Bun.color(hex, 'ansi')` emits a raw newline                      | 1.3.14        | 1.4.0    | Under `FORCE_COLOR=1` it degraded to `ansi-16` and wrote the index as a raw byte: `"\u001b[38;5;\nm"`. Index 10 is `\n`, so one coloured log line became two records.                                                                                                                                                                                                                                                        |
| `Bun.SQL`'s SQLite adapter stores `NULL` for a `Date`             | 1.3.14        | 1.4.0    | Now rejects, matching `bun:sqlite`. See [`Bun.SQL` and `bun:sqlite`](#bunsql-and-bunsqlite).                                                                                                                                                                                                                                                                                                                                 |
| `bun build` renames a nested `var` onto a `let` in the same block | 1.4.1         | 1.4.2    | 1.4.1 emitted `let exports2` beside `var exports2`.                                                                                                                                                                                                                                                                                                                                                                          |
| `.json()` on invalid JSON throws a generic `Failed to parse JSON` | 1.4.1         | 1.4.2    | 1.4.2 throws `SyntaxError: JSON Parse error: Expected '}'`.                                                                                                                                                                                                                                                                                                                                                                  |
