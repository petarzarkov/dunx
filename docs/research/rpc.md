# RPC transports: gRPC and JSON-RPC

Two verdicts. The word RPC is the only thing they share.

## Verdict

gRPC is **not** blocked by Bun. Bun 1.3.14 hosts a working gRPC server today:
`@grpc/grpc-js` 1.14.4 passed unary, server-streaming, client-streaming, bidirectional
streaming, metadata, deadlines and TLS, and emitted correct HTTP/2 trailers with zero
empty DATA frames. The one missing capability is narrower: **`Bun.serve` speaks no
HTTP/2 and can send no trailers**, so a gRPC server on Bun runs on `node:http2`, on its
own port, outside `Bun.serve({ routes })` and therefore outside every middleware, guard,
input reader and request log dunx has.

### gRPC: do not build

No `@dunx/grpc`, and no gRPC transport inside `@dunx/http`.

- **Owning package and subpath: none.** If the trigger below fires, the answer is a
  documented recipe plus roughly 80 lines of mount code in `@dunx/http` behind `./connect`,
  mounting `@connectrpc/connect` into the existing route table. Not a package, and not
  `@grpc/grpc-js` wrapped in decorators.
- **Why.** Rule 1's second half. `@grpc/grpc-js` and `@connectrpc/connect` both solve service
  hosting completely; what dunx would add is DI resolution plus a decorator over
  `addService`, the `@dunx/queue-dashboard` shape. A consumer also has to adopt a protobuf
  toolchain, and protobuf replaces the zod and Standard Schema contract the rest of dunx is
  built on, so the parts of `@dunx/http` a gRPC package would reuse are the ones it cannot.
- **Trigger that changes the answer.** Both halves, not either: an external issue naming
  gRPC with a real `.proto` workflow behind it, **and** `Bun.serve` gaining HTTP/2
  (oven-sh/bun#14672, open). With #14672 shipped, Connect's `createFetchHandler` output
  becomes an ordinary `Bun.serve` route, middleware and request logging apply unchanged,
  and native gRPC clients reach it. Until then a gRPC server on Bun is a second server on a
  second port, which a consumer stands up in 20 lines without dunx.

### JSON-RPC: build later

- **Owning package and subpath: `@dunx/http`, behind `./rpc`.** `@dunx/http` is one of
  the core three that take the work, so this is not blocked by "a new package needs a
  user first". It is blocked by the sentence above it: correctness, docs and stability in
  the core three beat a new capability.
- **Now: a guide page**, `docs/guide/json-rpc.md`. A JSON-RPC endpoint on dunx today is one
  `@Post('/rpc')` handler and a `Map`, about 40 lines in the consumer's own app, and the
  page is worth more than the module until something needs the module.
- **Trigger.** Either an external issue, **or** a second in-repo consumer of the envelope.
  The second is the live one: `tools/mcp/src/protocol.ts` already declares the envelope and
  the error codes, so the day MCP gains a Streamable HTTP transport, or a JSON-RPC route
  lands in `@dunx/http`, Rule 2 forces the declaration down to one owner. Build it then, and
  move the codec in the same change.

## What Bun gives us

All output below was run on Bun 1.3.14 (`0d9b296af33f2b851fcbf4df3e9ec89751734ba4`). Probes
and raw output: `<SCRATCH>/probes/`, index in `probes/RESULTS.md`.

### node:http2 has a real server

`createServer` and `createSecureServer` are both functions (probe 01). Presence is not
function, so probe 02 started an h2c server, connected a client, and asked for trailers:

```
$ bun probes/02-h2-roundtrip.ts
[server] stream received, :path = /pkg.Svc/Method   [server] wantTrailers fired
[client] RESULT: body=hello-from-h2 trailers={"grpc-status":"0","grpc-message":"OK"}
[server] error state: none
```

`respond(..., { waitForTrailers: true })`, the `wantTrailers` event, `sendTrailers()` and
the client-side `trailers` event all work. This is the whole gRPC transport requirement.
Bun's own documentation agrees: node:http2 is "Client & server are implemented. 94% of
Node.js's test suite passes" (https://bun.com/docs/runtime/nodejs-apis). Server support
landed in Bun 1.2 (https://bun.sh/blog/bun-v1.2), closing
https://github.com/oven-sh/bun/issues/8823.

### Bun.serve does not, and has no trailers

```
$ bun probes/04-bunserve-h2-trailers.ts
"trailers" in Response.prototype  : false
Response init "trailers" honoured : undefined
h2c against Bun.serve -> session error: ERR_HTTP2_SESSION_ERROR NGHTTP2_PROTOCOL_ERROR
fetch to h2-only server threw: Malformed_HTTP_Response
```

Three separate gaps: `Bun.serve` answers an HTTP/2 preface with a protocol error;
`Response` has no trailer channel, so a `Bun.serve` handler cannot send `grpc-status`
after the body; and `fetch` cannot read trailers or even talk to an h2-only origin.
`Bun.serve` accepts `http2`, `alpn`, `allowH2` and `protocol` keys without throwing, and
none of them do anything. https://github.com/oven-sh/bun/issues/14672, open.

### grpc-js works, all four call types

```
$ bun probes/grpc-sandbox/probe.ts          # @grpc/grpc-js 1.14.4
[grpc] UNARY OK -> hello dunx
[grpc] SERVER-STREAM OK -> tick:3, tick:2, tick:1
[grpc] DEADLINE STATUS -> code=4 details=Deadline exceeded after 0.001s,...
$ bun probes/grpc-sandbox/probe-bidi.ts
[server] client metadata x-tenant = acme
[grpc] BIDI OK -> echo:a, echo:b     [grpc] CLIENT-STREAM OK -> x+y
$ bun probes/grpc-sandbox/probe-tls.ts
[tls] TLS UNARY OK -> tls-hello secure
```

A throwaway `package.json` under `probes/grpc-sandbox/`, so the repo lockfile is untouched.

### The Envoy trailer bug is fixed

https://github.com/oven-sh/bun/issues/21759 reported a grpc-js server on Bun 1.2.20
emitting repeated empty DATA frames and no trailers, which made Envoy 1.34.3 abort with
`PROTOCOL_ERROR`. It is closed with no fix version named, so probe 3d read the wire with a
raw `node:http2` client rather than trusting grpc-js to parse its own output:

```
$ bun probes/grpc-sandbox/probe-frames.ts
/greeter.Greeter/SayHello   dataEvents=1 empty=0 bytes=13
    trailers={"grpc-status":"0","grpc-message":"OK"}
/greeter.Greeter/Countdown  dataEvents=2 empty=0 bytes=16
    trailers={"grpc-status":"0","grpc-message":"OK"}
```

Zero empty frames, one DATA event per message, trailers present. Fixed on 1.3.14.

### No native protobuf

Probe 05 enumerated all 108 `Bun.*` keys and matched none against
`/prot|rpc|grpc|http2|h2|codec/`; `bun:protobuf` and `bun:grpc` do not resolve. Protobuf is
entirely a library and toolchain question.

### Connect-RPC runs on Bun.serve

`@connectrpc/connect/protocol` exports `createFetchHandler`, turning a Connect handler into
`(Request) => Promise<Response>`. That is the `Bun.serve` signature.

```
$ bun probes/connect-sandbox/probe-bunserve.ts
[connect] Bun.serve on http://localhost:34609/ protocol HTTP/1.1
[connect] UNARY -> hello dunx (hdr=acme)
[connect] SERVER-STREAM -> tick:3, tick:2, tick:1
[connect] ERROR -> code=3 name=InvalidArgument msg=nope
[connect] RAW JSON POST -> 200 {"message":"hello curl (hdr=-)"}
$ bun probes/connect-sandbox/probe-grpcweb3.ts
grpc-web SERVER-STREAM over Bun.serve h1.1 -> gw:3, gw:2, gw:1
```

Unary, server-streaming, error codes, request headers, and a plain `curl`-shaped JSON POST,
all from one `Bun.serve` handler over HTTP/1.1. gRPC-Web works too, unary and streaming,
because it carries its trailers inside the body. Native gRPC over HTTP/1.1 fails: it needs
real trailers.

## Library decision

Take `@grpc/grpc-js` (optional peer, own port) for native gRPC hosting,
`@connectrpc/connect` (optional peer) for Connect and gRPC-Web on `Bun.serve`, and
consumer-owned `@bufbuild/protobuf` plus `buf` for the protobuf runtime and codegen. Never
a dunx gRPC server, a dunx protobuf codec, or protobufjs (8.7.2, 3.70 MB) inside dunx. For
the JSON-RPC envelope, take dunx's own ~120 lines over `@modelcontextprotocol/sdk`, jayson
or a Nest port.

Measured weights, `bun pm view`:

| Package                    | Version | Deps                                                  | Unpacked           |
| -------------------------- | ------- | ----------------------------------------------------- | ------------------ |
| `@grpc/grpc-js`            | 1.14.4  | 2 direct, 33 installed                                | 2.51 MB            |
| `@grpc/proto-loader`       | 0.8.1   | 4 (`lodash.camelcase`, `long`, `protobufjs`, `yargs`) | -                  |
| `@connectrpc/connect`      | 2.1.2   | **0**, peer `@bufbuild/protobuf`                      | 0.86 MB            |
| `@connectrpc/connect-node` | 2.1.2   | **0**                                                 | 213 KB             |
| `@bufbuild/protobuf`       | 2.14.0  | **0**                                                 | 1.92 MB            |
| `@bufbuild/buf`            | 1.72.0  | platform binary                                       | **121 MB** on disk |

Connect wins Rule 1 twice over grpc-js: it runs on `Bun.serve`, preference 1, where
grpc-js runs on `node:http2`, preference 2; and its dependency closure is empty, where
grpc-js pulls 33 packages including `lodash.camelcase` and `yargs` through
`@grpc/proto-loader`. `lodash` is on Rule 1's banned list, and the ioredis-inside-bullmq
reasoning applies since the ban is on dunx reimplementing a Bun primitive rather than on an
integration's internal engine, but the contrast is one-sided.

JSON-RPC is the case where Rule 1's second half does not bite. The spec is one page, there
is no engine to get wrong, and `tools/mcp/src/protocol.ts:5-15` already argues this in the
repo's own words: the rule "exists for ORMs, validators, auth flows and job queues - years
of edge cases - not for a framing loop".

## Public API

### The constraint, head on

Nest's microservice API is built on parameter decorators:

```ts
@GrpcMethod('Greeter', 'SayHello')
sayHello(@Payload() data: HelloRequest, @Ctx() ctx: RpcContext) {}
```

TC39 standard decorators have no parameter position, so `@Payload()` and `@Ctx()` cannot
exist in dunx and no design recovers them. dunx does not need them: `@dunx/http` already
answered this for HTTP routes and the answer generalises. **A handler takes exactly one
object, and its type comes from the decorator's `const O` generic.** `RouteInput` at
`packages/http/src/route/schema.ts:102-107` and `Input<O>` at `:89-99` are that answer;
`buildInputReader` at `packages/http/src/server/input.ts:217-229` folds the declared
schemas into one closure at boot. Nest needs decorators to label positional arguments.
There is one argument here, so there is nothing to label.

```ts
import { Logger } from '@dunx/core';
import { RpcController, RpcMethod, type RpcInput } from '@dunx/http/rpc';
import { z } from 'zod';

const addParams = z.object({ a: z.number(), b: z.number() });
const byPosition = z.tuple([z.number(), z.number()]);

@RpcController()
export class MathRpc {
  constructor(
    private readonly calc: Calculator,
    private readonly logger: Logger,
  ) {}

  @RpcMethod('math.add', { params: addParams })
  add(input: RpcInput<{ params: typeof addParams }>): number {
    return this.calc.add(input.params.a, input.params.b);
  }

  // params by position is the same code path: a tuple schema, not a second API.
  // No id on the wire makes the call a notification and nothing is written back.
  @RpcMethod('math.sub', { params: byPosition })
  sub(input: RpcInput<{ params: typeof byPosition }>): number {
    this.logger.info('sub', { id: input.id, method: input.method });
    return this.calc.sub(input.params[0], input.params[1]);
  }
}
```

Constructor injection with no annotation. `Calculator` and `Logger` are classes, so
`@dunx/transform` records them.

### The classes

Rule 3, and each has state, configuration or a lifetime. `RpcOptions` is a class rather than
the interface it otherwise would be, because a consumer injects it: `path` (default
`/rpc`), `maxBatch` (50) and `controllers`.

```ts
// codec.ts - the canonical declaration.
export const RpcErrorCode = Object.freeze({
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL: -32603,
} as const);
export type RpcErrorCode = (typeof RpcErrorCode)[keyof typeof RpcErrorCode];
export type RpcId = string | number | null;
export interface RpcRequest {
  readonly jsonrpc: '2.0';
  readonly id?: RpcId;
  readonly method: string;
  readonly params?: readonly unknown[] | Record<string, unknown>;
}

export class RpcError extends AppError {
  constructor(
    readonly code: RpcErrorCode | number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
  }
}
// registry.ts - state, so a class.
export class RpcRegistry {
  register(name: string, handler: RpcHandler): void;
  lookup(name: string): RpcHandler | undefined;
  names(): readonly string[]; // also what an OpenRPC document would read
}

// dispatcher.ts - transport-independent, so it is its own class.
export class RpcDispatcher {
  constructor(
    private readonly registry: RpcRegistry,
    private readonly options: RpcOptions,
    private readonly logger: Logger,
  ) {}
  /** One request in. `null` for a notification. */
  one(payload: unknown): Promise<RpcResponse | null>;
  /** An object or a batch array in. `null` when all members were notifications. */
  many(payload: unknown): Promise<RpcResponse | readonly RpcResponse[] | null>;
}

// module.ts - forRoot because it takes options.
export class RpcModule {
  static forRoot(options?: Partial<RpcOptions>): ModuleRef;
  static forRootAsync(options: AsyncOptions<RpcOptions>): ModuleRef;
}
```

Two transports share `RpcDispatcher`. The HTTP mount registers one POST route through the
existing route table; the WebSocket mount is an ordinary `@Gateway` whose `message` handler
calls `many()`. Neither transport owns the dispatch.

### What the existing machinery already covers

| Concern                                             | Covered by                                  |
| --------------------------------------------------- | ------------------------------------------- |
| `params` by name                                    | `z.object` through `StandardSchemaV1`. Free |
| `params` by position                                | `z.tuple`, the same `validate` call. Free   |
| `params` absent                                     | schema defaults. Free                       |
| Body parsing, content type, 415                     | `parserFor`, `input.ts:78-98`. Free         |
| Raw request inside a handler                        | `RequestContext`, always bound. Free        |
| Batch array dispatch                                | new code: the loop and `maxBatch`           |
| Notification, and 204 for an all-notification batch | new code                                    |
| Reserved error codes and the envelope               | new code                                    |
| Method registry and decorator                       | new code                                    |

`params` by name against by position is the finding worth keeping: both are one
`schema['~standard'].validate(value)` call on `request.params`, so the Standard Schema path
covers all of it and no positional adapter is needed. What it cannot do is the envelope.
`errorMapper` at `packages/http/src/server/errors.ts:137-160` produces
`{ error, status, issues? }` with a 4xx or 5xx status; JSON-RPC needs
`{ jsonrpc, id, error: { code, message } }` under HTTP 200. A JSON-RPC route bypasses the
default mapper, and `ValidationError` becomes `INVALID_PARAMS` rather than being serialised.

## Where it lives

`@dunx/http`, subpath `./rpc`, files under `packages/http/src/rpc/`. Not a new package:
`@dunx/http` already owns route discovery, the input reader, the Standard Schema contract,
`Bun.serve` and the gateways, and each is a dependency of a JSON-RPC endpoint.

### The Rule 2 finding, and it is the most important one in this report

`tools/mcp/src/protocol.ts` already declares JSON-RPC 2.0 by hand. There is no violation
today, because there is exactly one consumer. A JSON-RPC endpoint in `@dunx/http` makes a
second, and these are the lines that would be duplicated:

- `protocol.ts:19-24` - `JsonRpcRequest`, the envelope interface.
- `protocol.ts:34-40` - `RpcError`, a frozen object with three codes:
  `METHOD_NOT_FOUND: -32601`, `INVALID_PARAMS: -32602`, `INTERNAL: -32603`.
- `protocol.ts:42-50` - `reply` and `fail`, the two encoders, both module-private.
- `protocol.ts:65` - `if (request.id === undefined) return null;`, the notification rule.

They would also **disagree**, which is the failure mode Rule 2 names rather than disk space.
mcp declares three of the five reserved codes; `-32700` and `-32600` appear nowhere in the
repo, and `-32603` is declared but never emitted. An HTTP endpoint needs all five, being the
side that meets malformed input. mcp also has no batch handling, so a parsed batch array
falls through `id === undefined` and is dropped as a notification: correct for mcp, whose
2025-06-18 revision has no JSON-RPC batching, and wrong for anything else.

**The lowest common owner is `@dunx/http`.** `tools/mcp/package.json` lists `@dunx/http`
as a required `peerDependency` alongside `@dunx/core`, and `tools/mcp/src/index.ts:24-31`
already re-exports `routesOf` and `gatewaysOf` from it. The move creates no cycle and no
new dependency, and it repeats the move `providersOf` and `modulesOf` already made from
`@dunx/mcp` down to `@dunx/core`. `@dunx/core` is lower still, but a wire codec does not
belong in a zero-dependency DI container.

The migration: `@dunx/http/rpc` declares `RpcRequest`, `RpcResponse`, `RpcErrorCode` and the
encoders; `protocol.ts` deletes lines 19-24, 34-40 and 42-50 and imports them, keeping its
`handle` and newline-delimited `serve` since MCP dispatch and stdio framing are MCP's; and
mcp's public `RpcError` at `tools/mcp/src/index.ts:1` becomes
`export { RpcErrorCode as RpcError }`, deprecated for one major so no consumer breaks.

### OpenRPC

`@dunx/openapi` cannot describe a JSON-RPC endpoint, and the gap is worth close to
nothing: OpenAPI would show one `POST /rpc` with an opaque body, which is worse than
showing nothing. OpenRPC is the real schema language here, and its document is derivable
from the same registry plus the same zod schemas that already feed `z.toJSONSchema`, but no
OpenRPC explorer has anything like Swagger UI's reach, so the document would be generated
and unread. The registry's `names()` plus each method's params schema is enough to add it
later without redesign, so leaving it out costs no future move.

## What it refuses

- **No gRPC package, and no `@dunx/grpc` by another name.** A consumer wanting native gRPC
  on Bun runs `@grpc/grpc-js` on its own port. Documented, not wrapped.
- **No protobuf codec, no `.proto` parser, no codegen inside dunx.** `buf` and
  `@bufbuild/protoc-gen-es` own that, and dunx never shells out to them.
- **No `@Payload()`, no `@Ctx()`, no parameter decorator of any kind**, and no
  `reflect-metadata` to make them possible. **No JSON-RPC over stdio in `@dunx/http`**
  either: that transport is `tools/mcp/src/protocol.ts:138-184` and stays there.
- **No second WebSocket envelope.** `packages/http/src/ws/envelope.ts` is dunx's
  `{ event, data }` frame and JSON-RPC is a different envelope on the same socket, so an
  `RpcGateway` selects the JSON-RPC codec rather than extending `decode`. The two must not
  merge into one codec that guesses.
- **No response-schema validation**: `RouteSchemas.response` is documentation only
  (`route/schema.ts:62-67`) and `RpcSchemas` matches it. **No batch without a bound**
  (`maxBatch` 50). And **no 4xx for an RPC-level failure**: a reached method that threw is
  HTTP 200 with an `error` member, per spec. Only a malformed HTTP request is a 4xx.

## Cost

### JSON-RPC in `@dunx/http/rpc`, if the trigger fires

| Item                                                    | Cost                                                                                                             |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `rpc/codec.ts`                                          | ~90 LOC, envelope, five codes, encoders, `RpcError`                                                              |
| `rpc/marker.ts`, `rpc/decorators.ts`, `rpc/discover.ts` | ~190 LOC, mirroring `route/marker.ts` and `route/discover.ts:56-98`                                              |
| `rpc/registry.ts`, `rpc/dispatcher.ts`                  | ~200 LOC, the batch and notification loop                                                                        |
| `rpc/options.ts`, `rpc/module.ts`, `rpc/gateway.ts`     | ~170 LOC                                                                                                         |
| Tests                                                   | ~450 LOC across 5 files, all under the 500-line cap                                                              |
| `tools/mcp/src/protocol.ts`                             | net **minus** ~30 LOC, plus one deprecated alias                                                                 |
| New dependencies                                        | **zero**, runtime and dev                                                                                        |
| Docs                                                    | `docs/guide/json-rpc.md`, plus a section in `docs/architecture/http.md`, plus one entry in `PUBLISHED_REFERENCE` |
| Examples                                                | `examples/full` gains one `@RpcController`. `minimal` unchanged                                                  |
| CI                                                      | no new job and no new service. `bun run gen:cov` rerun for the http badge                                        |
| Publish                                                 | minor on `@dunx/http`, minor on `@dunx/mcp`, `@dunx/testing` republished                                         |

Roughly 1100 lines including tests, one new public subpath, no new dependency. The
`@dunx/testing` republish is the existing `^0.4.0` constraint in ROADMAP, not a new cost.

### gRPC, if it is ever built

The dunx side is the small half. What a consumer adopts is the cost.

| Item                         | Cost                                                                                                                                                                                                                                                      |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Consumer: protobuf toolchain | `@bufbuild/buf` 1.72.0 pulls a **121 MB** platform binary as a dev dependency                                                                                                                                                                             |
| Consumer: codegen            | `buf generate` ran in **0.475 s** and emitted **71 lines** for a two-method service. It must run in CI, and the output is either committed or built. Plus `buf.yaml`, `buf.gen.yaml`, and a `proto/` tree in the `package foo.v1` layout buf lint expects |
| Consumer: schema duplication | messages live in `.proto`, so every request type exists twice if the app also has zod DTOs. dunx has no answer to this and would not gain one                                                                                                             |
| Consumer: runtime peers      | `@connectrpc/connect` plus `@bufbuild/protobuf`, 2.78 MB unpacked, 0 transitive. Or `@grpc/grpc-js`, 2.51 MB and 33 installed packages                                                                                                                    |
| Consumer: deployment         | until oven-sh/bun#14672 ships, either a second port or a proxy translating gRPC to Connect                                                                                                                                                                |
| dunx: mount code             | ~80 LOC for Connect on `Bun.serve`, or ~250 LOC for a grpc-js adapter with DI, lifecycle and a second bound port                                                                                                                                          |
| dunx: tests                  | ~300 LOC, needing generated fixtures committed under a `templates`-style exclusion so the root coverage run does not compile them                                                                                                                         |
| dunx: docs and CI            | one guide page, one architecture page, and a codegen step or committed fixtures. `internal/bench` would want a subject, a third server process in the harness                                                                                             |

The 121 MB binary is the number to weigh. A consumer comparing dunx with Nest pays the same
toolchain cost for `@nestjs/microservices`, so it is not a dunx penalty, but it is why a
gRPC recipe in the docs serves the same reader for none of the maintenance.

## Risks and open spikes

- **`Bun.serve` HTTP/2 is the single blocking item**, oven-sh/bun#14672, open since
  October 2024 with no maintainer commitment. The whole gRPC verdict is downstream of it.
  Re-probe on each Bun minor with `probes/04-bunserve-h2-trailers.ts`; the verdict flips
  when the h2c line stops returning `NGHTTP2_PROTOCOL_ERROR`. **`Response` trailers are a
  second, separate gap**: h2 on `Bun.serve` without a trailer API on `Response` still
  hosts no native gRPC. Both are needed.
- **oven-sh/bun#21759 is closed with no fix version.** Verified fixed on 1.3.14 by reading
  the wire, not by trusting grpc-js. A regression is silent to a loopback test and fatal
  behind Envoy, so `probes/grpc-sandbox/probe-frames.ts` asserts `empty=0` rather than
  "the call succeeded".
- **Bun leaks an internal error from the node:http2 client.** Against an HTTP/1.1-only
  origin, `http2.connect()` prints
  `TypeError: The "authority" argument must be of type string, Object, or URL. Received type number (825110816)`
  from `node:http2:2727` before the clean `ERR_HTTP2_SESSION_ERROR` arrives. Reproducer:
  `probes/06-h2client-bug.ts`. Cosmetic, but it is an uncatchable stack trace in a
  consumer's logs, and worth an upstream issue whatever the verdict here, since the
  outbound `HttpClient` in `@dunx/http/client` could reach the same path.
- **Spike still open if JSON-RPC is built:** whether a batch shares one `RequestContext`
  scope or opens one per member. Per member is correct for log correlation and costs an
  `AsyncLocalStorage.run` per element; measure against `cost-of-logging.md`.
- **Not a risk:** `@grpc/grpc-js` on Bun. Four call types, metadata, deadlines, TLS and
  trailers all verified.
