# Message brokers: Kafka and RabbitMQ

Research only. Nothing in the repo was modified. Every number was measured on Bun 1.3.14 (revision
`0d9b296af33f2b851fcbf4df3e9ec89751734ba4`) against real brokers in throwaway Docker containers (`rabbitmq:4-alpine`,
`redpanda:latest`), both removed afterwards. Probe sources in `../probes/`.

## Verdict

**Kafka: do not build.** Owning package if it ever is: `@dunx/infra`, subpath `./kafka`. Bun ships no Kafka primitive,
so dunx would contribute wiring and nothing else, and `docs/ROADMAP.md:48` states the gate: "A new package needs a
user first." The word Kafka appears nowhere in this repo (`grep -rniE 'kafka|rabbitmq|amqp'` over `*.md`, `*.ts`,
`*.json` outside `node_modules` returns zero hits), so there is not even an internal user.

Triggers, any one sufficient:
1. An issue from someone who is not the owner, per `docs/ROADMAP.md:48`.
2. Bun shipping a native Kafka client. `oven-sh/bun#19337` is open, filed 2025-04-28, unassigned, no maintainer
   response. If it lands, the shape becomes `@dunx/infra/kafka` over `Bun.Kafka` the way `@dunx/infra/redis` sits over
   `Bun.RedisClient`, and the library question disappears.
3. `~/repos/nestjs-template` growing a Kafka dependency, making it a reference implementation to port rather than a
   design from scratch.

**RabbitMQ: do not build now, first in line when a trigger fires.** Owning package: `@dunx/infra`, subpath `./amqp`.
Same gate, same triggers. It leads Kafka on evidence, not demand: `rabbitmq-client` 5.0.8 has 0 dependencies, 197.70
KB unpacked, bundled `.d.ts`, and its `Consumer.close()` waited 1213 ms for three in-flight handlers before resolving;
the best Kafka client does not do that.

Neither is a new package: both are subpaths of `@dunx/infra`, which already owns long-lived connections and the
handler-discovery machinery.

## What Bun gives us

**Bun has no native Kafka client. It has no native AMQP client either.** Four checks.
```
$ bun probes/bun-surface.ts
total own props on Bun: 113 / --- matches on Bun --- / --- end matches ---
$ grep -rniE 'kafka|amqp|rabbit|pulsar|\bmqtt\b' node_modules/.bun/node_modules/bun-types/
bun-types/docs/runtime/http/websockets.mdx:194: ...similar to [MQTT](...) and [Redis Pub/Sub](...)
$ bun probes/bun-builtins.ts
FAIL bun:kafka -> Cannot find package 'bun:kafka'   |   OK node:net -> ...,connect,createConnection,...
FAIL bun:amqp  -> Cannot find package 'bun:amqp'    |   OK node:tls -> ...,TLSSocket,connect,...
$ strings -n 5 ~/.bun/bin/bun | grep -icE 'kafka' -> 1 ; 'amqp' -> 0 ; 'RedisClient' -> 3
```

113 own property descriptors on `Bun`, enumerable and non-enumerable, zero matching `kafka`, `amqp`, `rabbit`,
`produc`, `consum`, `broker`, `nats`, `pulsar`, `mqtt`. One hit in bun-types 1.3.14, and it is prose comparing
`ServerWebSocket.publish` to MQTT, with no type declarations. The single `kafka` string in the 92.7 MB binary is
`node-rdkafka` inside Bun's hardcoded list of packages needing native builds; `amqp` returns nothing; the
`RedisClient` control returns 3, so the method finds what is present. bun.com/docs documents Redis, S3, SQL, SQLite
and WebSockets, and no Kafka, AMQP, RabbitMQ, NATS or MQTT client.

**What Bun does give is the transport.** All three candidates open sockets through `node:net` and `node:tls`, which
Bun implements natively: `amqplib/lib/connect.js:172,174` is `net.connect` / `tls.connect`, and
`@platformatic/kafka/dist/network/connection.js:3,161` imports and calls `createConnection` from `node:net`.

This settles the Rule 1 collision before it starts. `bullmq` needed a Bun adapter because `ioredis` duplicates
`Bun.RedisClient`, an API Bun ships. A Kafka or AMQP client duplicates nothing: it speaks a wire protocol Bun has no
client for, over a socket layer that is already Bun's. There is no `createBunRedisClient` analogue to look for, and
none of the three exposes a socket-factory seam that would accept one.

Additions for `docs/bun-apis.md`, verified here and absent from it (`grep -ci` returns 0 for each): `Bun.cron`
(5 fields, minute hour day month weekday, no seconds; statics `remove` and `parse`; adjacent to repeatable jobs in
`@dunx/infra/queue`), `Bun.secrets` (`get`, `set`, `delete`), `Bun.YAML` / `Bun.JSON5` / `Bun.JSONC` / `Bun.JSONL`,
`Bun.MD4` / `Bun.MD5`, `Bun.sliceAnsi` / `Bun.wrapAnsi` / `Bun.stripANSI`, `Bun.randomUUIDv5`, `Bun.shrink`,
`Bun.postgres`. Plus the negative result above, so it is not re-checked.

## Library decision

### Kafka candidates
| Package | Version | Published | Unpacked | Deps | Module | Types | Native | Runs under Bun 1.3.14 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `@platformatic/kafka` | 2.9.0 | 2026-08-08 | 1.42 MB | 9 direct (`ajv`, `ajv-draft-04`, `avsc`, `debug`, `fastq`, `mnemonist`, `scule`, `@platformatic/dynamic-buffer`, `@platformatic/wasm-utils`); 22 installed, 13 MB | ESM only | bundled | JS + WASM, optional N-API addon | **Yes, fully** |
| `kafkajs` | 2.2.4 | 2023-02-27 | 0.73 MB | 0 | CJS | bundled | pure JS | Yes, with a stderr defect |
| `@confluentinc/kafka-javascript` | 1.10.0 | 2026-07-01 | 14.40 MB | 5 (`@mapbox/node-pre-gyp`, `bindings`, `js-yaml`, `nan`, `tar`) | CJS | bundled | NAN / V8 ABI | **No. Fails at the dynamic linker** |
| `node-rdkafka` | 3.6.1 | 2025-12-03 | 14.77 MB | 2 (`bindings`, `nan`) | CJS | bundled | NAN / V8 ABI | No, same class |

**The librdkafka route is disqualified, and the mechanism is worth stating once.**
```
$ bun probes/confluent/conf.probe.ts
bun: symbol lookup error: .../confluent-kafka-javascript.node:
  undefined symbol: _ZN2v816FunctionTemplate12SetClassNameENS_5LocalINS_6StringEEE
$ nm -D --undefined-only confluent-kafka-javascript.node | grep -c '_ZN2v8' -> 49 ; 'napi_' -> 0
$ nm -D --undefined-only .../oxc-parser/parser.linux-x64-gnu.node | grep -c '_ZN2v8' -> 0
$ strings .../oxc-parser/parser.linux-x64-gnu.node | grep -o 'napi_register_module_v1' -> found
```

The prebuilt binary downloads and links under `bun pm trust --all` (984 ms), then kills the process at `dlopen`.
`oxc-parser` is N-API, which Bun implements. Both librdkafka bindings are NAN, needing the V8 C++ ABI, which
JavaScriptCore does not have. Not a Rule 1 judgement call about native dependencies, and not fixable from dunx. Matches
`oven-sh/bun#24258` and `confluent-kafka-javascript#264`.

**`kafkajs` is stalled and prints a stack trace on every connection.** Last release 2.2.4 on 2023-02-27, 3.5 years
ago. Last commit to `master` 2024-05-16 with the message "Remove sponsorships"; last functional commit 2023-02-27. 355
open issues. `2.3.0-beta.3` exists and has not been promoted. It does produce and consume under Bun, so the old
`oven-sh/bun#6429` and `#6571` producer hangs are gone, but:
```
$ bun probes/kjs/kjs.probe.ts
TimeoutNegativeWarning: -1787033536055 is a negative number.
      at scheduleCheckPendingRequests (.../kafkajs/src/network/requestQueue/index.js:317:37)
[41ms] sent: [{"topicName":"dunx.probe","partition":1,"baseOffset":"1",...}] / [86ms] msg p=1
EXIT code=0 at 5108ms
```

Root cause is kafkajs, not Bun: `this.throttledUntil = -1` at `requestQueue/index.js:57`, then `scheduleAt =
this.throttledUntil - Date.now()` at `:312`. Node clamps a negative `setTimeout` silently; Bun emits
`TimeoutNegativeWarning` with a stack trace to stderr, confirmed with a one-liner. Every request finding an empty pending
queue writes that trace. An unmaintained library polluting stderr on Bun specifically is not a base for a subpath.

**`@platformatic/kafka` is the pick.** Full protocol coverage under Bun:
```
$ bun probes/k-plat/kplat.probe.ts
[253ms] topic created (3 partitions) / [271ms] produced offsets: [{"p":0,"off":"0"},{"p":2,"off":"0"}]
[497ms] msg partition=0 offset=0 key=k2 value={"n":2} hdr=[]
[505ms] msg partition=2 offset=0 key=k1 value={"n":1} hdr=[["x-request-id","abc"]]
[529ms] admin+produce+consumer-group+manual-commit+headers+close OK / EXIT 0 at 529ms
```

Admin `createTopics` and `metadata`, keyed produce with partition assignment, consumer group with `mode: 'earliest'`,
per-message `commit()` under `autocommit: false`, header round trip, clean exit in 529 ms. 8 MB payloads round trip
byte-exact (`probes/k-plat/large.probe.ts`: declared equals actual at 1 KB, 128 KB, 1 MB, 8 MB).

Its checksum path lands on the right side of Rule 1 without being asked: `crc32c.js` ends `export const crc32c =
loadNativeCRC32C() ?? wasmCRC32C;`, and under Bun `m.crc32c.name` is `nativeCRC32C`, so it selects `@node-rs/crc32`, a
napi-rs addon of the same family as `oxc-parser`, which loads and computes correctly (`crc32c('hello') = 2591144780`).
WASM is the fallback and the JS table is dead code. `@node-rs/crc32` and `protobufjs` are `optionalDependencies` of the library, so neither is dunx's.

Caveats: `engines` is `">= 22.22.0 || >= 24.6.0"` and Bun reports `process.versions.node = 24.3.0`, satisfying the
first clause, so `bun install` is quiet. It states no Bun support, so these probes are the only evidence. Its shutdown
is a defect dunx would own, below.

### RabbitMQ / AMQP candidates
| Package | Version | Published | Unpacked | Deps | Module | Types | Native | Runs under Bun 1.3.14 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `rabbitmq-client` | 5.0.8 | 2025-12-01 | 197.70 KB | 0 | CJS (`main: ./lib/index.js`) | bundled `lib/*.d.ts`, no `types` field | pure JS | **Yes, fully** |
| `amqplib` | 2.0.1 | 2026-05-10 | 0.55 MB | 0 (v2 dropped them) | CJS with `exports` map | bundled `index.d.ts`, plus `@types/amqplib` | pure JS | Yes, fully |
| `amqp-connection-manager` | 5.0.0 | 2025-09-29 | 147.67 KB | 1 (`promise-breaker`) | CJS | bundled | pure JS | Not probed. A wrapper over `amqplib` |
```
$ bun probes/amqp/rmq2.probe.ts   # rabbitmq-client
[28ms] connection established / [71ms] consumer ready / [2027ms] handler got msg / [3041ms] closed
$ bun probes/amqp/amqplib.probe.ts
[27ms] connected, serverProperties: "RabbitMQ" / [664ms] received ["{\"n\":1}","{\"n\":2}"]
[672ms] closed. publish+consume+ack+headers+graceful close OK
```

**The historical "Invalid frame" breakage is fixed.** `oven-sh/bun#5627` (2023-09-17, amqplib invalid frame on large
messages, labelled `node:stream`) is CLOSED via PR #36287; `#14032` (2024-09-19, NestJS over amqplib, same symptom)
closed as a duplicate. Re-measured rather than trusted: `probes/amqp/large.probe.ts` reports `roundtrip=OK exact` for
both clients at 1 KB, 64 KB, 128 KB, 1 MB and 8 MB, comparing declared against received length. `oven-sh/bun#7851` (a
`node:net` port TypeError with rabbitmq-client) did not reproduce. `#4791` was against Bun 1.0.0.

**`rabbitmq-client` is the pick**, on 0 dependencies, 197.70 KB, typed without a `@types/*` package, and one behaviour
`amqplib` leaves to the caller:
```
$ bun probes/amqp/drain.probe.ts
[349ms] SIGTERM point: started=3 finished=0 - now closing / [1553ms] handler done (finished=3)
[1562ms] sub.close() resolved after 1213ms; DRAINED: close waited for in-flight handlers / EXIT 0
```

`amqplib` is a channel API with no consumer object to close, so a dunx wrapper would track in-flight deliveries itself.
One risk against `rabbitmq-client`: a single maintainer. Server-side detail that cost a probe cycle and belongs in any
example: RabbitMQ 4 refuses `transient_nonexcl_queues`, so `durable: false` fails with `INTERNAL_ERROR` at
`QueueDeclare`.

### Exit cleanliness, all four clients
Three network conditions, with a `process.on('exit')` marker under `timeout -s KILL`:

| Client | Healthy | Refused port | Black-holed IP (`10.255.255.1`) |
| --- | --- | --- | --- |
| `rabbitmq-client` | exit 0, 1560 ms | exit 0 | exit 0, 1571 ms |
| `amqplib` | exit 0, 420 ms | exit 0, 84 ms | exit 0, 575 ms |
| `@platformatic/kafka` | exit 0 | exit 0 | exit 0 |
| `kafkajs` | exit 0 | exit 0 | exit 0 |

Every one released the event loop. Compare `docs/roadmap/queue-shutdown-sigterm.md:29-33`, where a black-holed address
hangs `Bun.RedisClient` itself and a refused port hangs the bullmq adapter forever. No leak of that class reproduced.

## Public API

Two independent module trees. No shared handler type, no shared decorator, no shared transport token. Every injection
site is a class, per Rule 3. TC39 method and class decorators only, no parameter decorators.
```ts
// @dunx/infra/amqp
export class AmqpOptions {
  url = 'amqp://localhost:5672'; prefetch = 10; reconnect = true;
}
export class AmqpMeta {
  queue!: string; exchange?: string; routingKey?: string; prefetch?: number;
}
export class AmqpModule {
  static forRoot(options?: Partial<AmqpOptions>): ModuleRef;
  static forRootAsync(options: AsyncOptions<AmqpOptions>): ModuleRef;
}
export class AmqpConnection implements OnShutdown {
  constructor(private readonly options: AmqpOptions, private readonly logger: Logger) {}
  connection(): Connection;
  async onShutdown(): Promise<void>;
}
export class AmqpPublisher implements OnShutdown {
  constructor(private readonly conn: AmqpConnection, private readonly context: RequestContext) {}
  async publish(exchange: string, key: string, body: unknown, options?: PublishOptions): Promise<void>;
  async onShutdown(): Promise<void>;
}
// Discovers @AmqpHandler methods, subscribes in onInit, drains in onShutdown.
export class AmqpRunner implements OnInit, OnShutdown {
  constructor(app: AppRef, root: ModuleRef, conn: AmqpConnection, log: Logger, ctx: RequestContext) {}
  async onInit(): Promise<void>;
  async onShutdown(): Promise<void>;
}
// A TC39 method decorator marking the function value, the same shape as
// @JobHandler at packages/infra/src/queue/decorators.ts:16.
export const AmqpHandler: (meta: AmqpMeta) => <T extends HandlerMethod>(value: T) => T;

@Injectable()
export class OrdersConsumer {
  constructor(private readonly orders: OrdersService) {}

  @AmqpHandler({ queue: 'orders.created', exchange: 'orders', routingKey: 'created' })
  async onCreated(m: AmqpMessage<OrderCreated>): Promise<void> {
    await this.orders.record(m.body); // ack on return, nack with requeue on throw
  }
}
```

`@dunx/infra/kafka` mirrors that skeleton (`KafkaConnection`, `KafkaRunner`, `KafkaModule.forRoot` / `forRootAsync`)
and diverges where the broker does:
```ts
export class KafkaOptions {
  brokers: readonly string[] = ['localhost:9092']; clientId = 'dunx'; groupId?: string; autocommit = false;
}
export class KafkaMeta {
  topic!: string; groupId?: string; fromBeginning?: boolean;
}
export class KafkaProducer implements OnShutdown {
  constructor(private readonly conn: KafkaConnection, private readonly context: RequestContext) {}
  async send(topic: string, messages: readonly KafkaOutbound[]): Promise<readonly KafkaAck[]>;
}
export const KafkaHandler: (meta: KafkaMeta) => <T extends HandlerMethod>(value: T) => T;

@Injectable()
export class EventsConsumer {
  @KafkaHandler({ topic: 'orders', fromBeginning: false })
  async onOrder(m: KafkaMessage<OrderEvent>): Promise<void> {
    m.partition; // number   m.offset; // bigint   m.headers; // ReadonlyMap<string, Buffer>
    // the runner commits after this resolves; a throw leaves the offset uncommitted
  }
}
```

`AmqpMessage` carries `exchange`, `routingKey`, `redelivered`, `deliveryTag`. `KafkaMessage` carries `partition`,
`offset`, `key`, `timestamp`. No union sits over them. `AsyncOptions<T>` is the existing `{ useFactory, inject }`
shape on `LoggerModule`, `RedisModule`, `FilesModule` and `DbModule`, so `forRootAsync` reads brokers off
`ConfigService`.

## Where it lives

`@dunx/infra`, subpaths `./amqp` and `./kafka`. Not new packages, not one package for both, not `@dunx/broker`. Neither
needs `@dunx/http`, so neither belongs above the web layer. Both need `@dunx/core`'s `collectModules`,
`readControllers`, `AppRef`, `ROOT_MODULE`, `OnInit`, `OnShutdown` and `Logger`, which is what `@dunx/infra/queue`
needs. A subpath is one manifest entry plus a build entrypoint, since `scripts/build-package.ts` derives entrypoints
from `exports`.

### One abstraction, two modules, or neither
**Neither yet. When it happens, two, and never one.** Nest's `ClientProxy` with `@MessagePattern` and `@EventPattern`
is the thing to avoid, and the probes give the reason in numbers rather than in principle.
- **Ordering.** Two Kafka messages with keys `k1` and `k2` landed on partitions 2 and 0 and were consumed `k2` then
  `k1`, inverting production order (probe output above). One AMQP queue delivered `n=1` then `n=2` in order. A shared
  abstraction must promise one of these and lie about the other.
- **Acknowledgement.** AMQP acks, nacks and rejects a single delivery, with `requeue` a parameter and `prefetch` the
  concurrency control. Kafka commits a per-partition offset, has no per-message nack, and redelivers by rewinding.
  `ack()` on a shared interface means two different things.
- **Failure.** An AMQP handler that throws can requeue that one message. A Kafka handler that throws either blocks its
  partition or skips the offset. There is no shared answer.
- **Drain.** `rabbitmq-client`'s `Consumer.close()` waits for in-flight handlers, 1213 ms measured.
  `@platformatic/kafka`'s `stream.close()` does not, and the commit that follows throws. A single abstraction would
  promise a drain it delivers on one backend only.

Request/response over a broker, which `@MessagePattern` implies, is worse: Kafka needs a reply topic and a correlation
id the framework invents, and that is an RPC framework, not a broker binding.

### What dunx contributes, and it is a short list
1. `forRoot` / `forRootAsync` reading brokers, credentials and prefetch off `ConfigService`.
2. Handler discovery, so a consumer is an injectable class with a decorated method rather than a callback registered
   in a bootstrap file.
3. Lifecycle: connect in `onInit`, drain and close in `onShutdown`, in container teardown order.
4. One log line per message through core's `Logger`, at the level policy of `RequestLoggingMiddleware`: a handler
   throw at `error`, a redelivery at `warn`.
5. Correlation-id propagation. `AmqpPublisher` and `KafkaProducer` stamp `RequestContext`'s `requestId` into headers;
   the runners wrap each handler in `runWithContext`. Headers round trip on both brokers, measured. Nothing in
   `packages/infra/src/queue/` does this today: `JobPublisher.publish` (`publisher.ts:71-80`) passes `data` through
   untouched and `JobDispatcher.dispatch` (`dispatcher.ts:44-57`) calls the handler with no `runWithContext`, so the
   gap is unclaimed.
6. Two measured defects fixed once instead of per app: the Kafka commit-before-close ordering, and the stream teardown
   that emits an unhandled `AbortError`.

Items 1 to 5 are wiring. That is a legitimate and small contribution, and it is the honest reason the verdict is not
yet: wiring is worth building when someone waits for it. `packages/infra/src/queue/` already holds the mechanism item
2 needs, and a broker consumer is the same shape:

| Piece | Location | Broker reuse |
| --- | --- | --- |
| `Symbol.for('dunx.job.handler')` | `queue/marker.ts:6` | Same pattern, different key |
| `markJobHandler` / `jobMetaOf` | `marker.ts:40-45` | Generic over `object`, reusable verbatim |
| `JobHandler` decorator | `decorators.ts:16-21` | TC39 method decorator marking the function value, ignores `context`. Copy the shape |
| `eachJobHandler` prototype walk | `discover.ts:23-46` | Reusable verbatim, most-derived wins |
| `discoverJobsOn`, `declaresJobHandler`, `classOf` | `discover.ts:54-83` | Binds to instances; checks the prototype without constructing; skips value and factory providers |
| `assertNoDuplicateJobs`, `discoverJobs`, `selectJobs` | `discover.ts:89-198` | Duplicate boot error, the provider and controller walk, filter plus misspelled-name boot error |
| `QueueRunner` | `queue/runner.ts` | Template for a container-owned consumer: `AppRef` + `ROOT_MODULE`, discovery in `onInit`, degrade rather than fail on an unreachable broker (`runner.ts:100-108`) |

The generic half depends only on `@dunx/core`'s `collectModules` (`packages/core/src/di/module.ts:194-217`),
`readControllers` (`module.ts:232-234`) and `ProviderEntry`. `packages/core/src/di/index.ts:28-31` already names those
two as the adapter seam for this.

**Rule 2 says it moves, and the precedent is exact:** `providersOf` and `modulesOf` went from `@dunx/mcp` to
`@dunx/core` the moment `@dunx/dashboard` was a second consumer. A broker subpath is the second consumer of the
handler scan. So the move is part of the broker change: a `HandlerScanner` class in `@dunx/core` (a class, not a
function bag, because it holds the marker symbol and the `seen` and `scanned` sets), parameterised by the `Symbol.for`
key, with `@dunx/infra/queue` constructing one. `JobMeta`, `DiscoveredJob` and the bullmq `Job` type stay in
`@dunx/infra/queue`, since `discover.ts:12` types the handler as `(job: Job) => unknown` and that is bullmq's.

The move happens with the second consumer, not before it. Extracting a scanner now, with one caller, is the
speculative abstraction the repo bans.

### Boundary against the existing queue

`@dunx/infra/queue` is bullmq over Redis and owns work this process created for itself to do later: a retry with
backoff, a rate limit, a cron, a job whose failure is this app's problem and whose payload nobody else reads.
`@dunx/infra/amqp` and `@dunx/infra/kafka` would own messages crossing a service boundary, where the producer does not
know the consumers, the payload is a contract between deployables, and delivery is the broker's guarantee rather than
a bullmq option object. The test is ownership of the failure: if a failed unit of work should be retried by the
process that created it, it is a job; if it should be redelivered to whichever service is listening, it is a message.
Neither subpath gets a scheduler, a retry-with-backoff policy, a dead-letter helper or a job state model, because all
four exist in `@dunx/infra/queue` and a second one repeats the `@dunx/queue-dashboard` round trip.

## What it refuses

- **No unified broker abstraction, no `ClientProxy`, no `@MessagePattern`.** Two module trees, two handler types.
- **No request/response over a broker.** No reply topics, no correlation-id RPC. An outbound call is `HttpClient` in
  `@dunx/http/client`.
- **No third job runner.** No retry policy, scheduler, dead-letter helper or job state model in either subpath. **No
  broker UI panel in `@dunx/dashboard`** either: the queues page is bull-board mounted, and a hand-rolled Kafka or AMQP
  panel is the same mistake with a different broker. If a panel is ever wanted, mount somebody's.
- **No wire protocol.** dunx writes no AMQP framing and no Kafka protocol codec. That is the "invent what a mature
  library already solves" failure at its worst. **No schema registry, no Avro, no Protobuf** either:
  `@platformatic/kafka` has Confluent Schema Registry support and `avsc` in its tree, and both stay the library's.
- **No `ioredis`, no `nan`-based addon.** The second is not a policy, it is a linker error.
- **No partition assignment strategy, rebalance listener or transactional producer.** Library surface, exposed by
  returning its objects rather than wrapping them, the way `JobPublisher` returns bullmq's own `Queue` and `Job`.

## Risks and open spikes

**1. `@platformatic/kafka` does not drain on close, and the commit after close throws.** Measured, and the
highest-value finding here:
```
$ bun probes/k-plat/drain2.probe.ts close-first
[1151ms] closing before awaiting in-flight
[1860ms] COMMIT FAILED off=0: Client is closed. code=PLT_KFK_NETWORK
[1861ms] RESULT started=1 committed=0 -> REDELIVERY of 1
$ bun probes/k-plat/drain2.probe.ts drain-first
[1391ms] awaiting in-flight handler before close
[2102ms] committed off=0 / in-flight settled: committed=1
```
`stream.close()` resolves while a handler is mid-flight; the handler's `commit()` then throws `PLT_KFK_NETWORK` from
`checkNotClosed` (`clients/base/base.js:233`), the offset is never committed, and the message is redelivered. Awaiting
in-flight work first commits cleanly. So `KafkaRunner.onShutdown` must stop pulling, await in-flight handlers, let
them commit, then close. Not optional, and not something an app should discover in production.

**2. `@platformatic/kafka`'s stream teardown can emit an unhandled `AbortError`.** Breaking out of `for await (const m
of stream)` while a fetch is in flight produced `AbortError: ABORT_ERR` at `internal:streams/destroy:167` and exited 1.
A minimal `node:stream` `Readable` with a `break`, with and without an `AbortSignal`, does not reproduce it under Bun,
so it is the library's teardown rather than Bun's iterator. Two mitigations measured: `stream.on('error', ...)` catches
it and the process survives; ending the loop with `stream.close()` instead of `break` produces no `AbortError` at all
and the iterator ends naturally. The runner should do both. Worth filing upstream with the reproduction.

**3. Would a broker consumer inherit the `queue-shutdown-sigterm.md` bugs?** Not those two, but yes to the class. Leak
A is `Bun.RedisClient`'s pending connect outliving `close()` (`queue-shutdown-sigterm.md:38-64`); Leak B is bullmq's
`BunRedisAdapter` reconnect timer that `disconnect()` returns early without clearing (`:66-104`). Neither client here
touches `Bun.RedisClient` or bullmq, and the exit matrix shows exit 0 in all three conditions for all four, so the two
recorded leaks do not transfer. The class does: risks 1 and 2 are new instances of it, found in 30 minutes of probing a
client nobody had run on Bun. `ShutdownHooks`'s `unref()`d forced exit
(`packages/core/src/di/shutdown-hooks.ts:97-108`, default 1000 ms) stays the backstop and covers any leaked handle
rather than an enumerated list. It does not make an uncommitted offset committed, so the drain in risk 1 is dunx's job
and the forced exit is no substitute.

**4. Unresolved: TLS and SASL.** Every probe ran plaintext against a local broker. Production brokers use `amqps://`
and Kafka `SASL_SSL`, meaning `node:tls` plus `SCRAM-SHA-512`, `PLAIN` or `AWS_MSK_IAM`. None was exercised. Largest
remaining risk and the first spike if a trigger fires: `/spike` a TLS plus SASL connection to a real managed broker
before fixing any API.

**5. Unresolved: consumer group rebalance.** Single-consumer, single-process probes only. A rebalance mid-handler is
where a Kafka binding earns or loses its correctness, and `@platformatic/kafka` exposes no rebalance listener that was
tested. **6. `rabbitmq-client` has one maintainer.** `amqplib` 2.0.1 (0 dependencies as of 2026-05-10) is the fallback, at the
cost of tracking in-flight deliveries in dunx. **7. `@platformatic/kafka` publishes fast**, 71 versions with 2.9.0 on 2026-08-08
and a `2.10.0-alpha.1` tag, so a peer range must be a caret on a probed minor, not `*`.

## Cost

Per family, if a trigger fires, RabbitMQ first. **Files and lines, `@dunx/infra/amqp`:** `options.ts` (~90), `connection.ts` (~150), `publisher.ts` (~110),
`runner.ts` (~170), `marker.ts` (~45), `decorators.ts` (~25), `module.ts` (~130), `errors.ts` (~30), `index.ts` (~35).
About 785 source lines over 9 files, none near the 500-line cap. Tests at the queue directory's 0.67 ratio add ~520
lines over 5 files. `@dunx/infra/kafka` is the same shape plus the drain and teardown handling: ~900 source, ~600
test.

**Rule 2 move:** extracting `HandlerScanner` into `@dunx/core` adds one file (~120 lines) plus an `index.ts` export, and
cuts `packages/infra/src/queue/discover.ts` from 198 lines to roughly 90. `discover.test.ts` (228 lines) moves with it.
This is the part most likely to break something that works today, and it must land as its own commit with the queue
tests green before either subpath is written.

**New peer dependencies**, optional, per Rule 1's second half:
```json
{
  "peerDependencies": {
    "rabbitmq-client": "^5.0.8",
    "@platformatic/kafka": "^2.9.0"
  },
  "peerDependenciesMeta": {
    "rabbitmq-client": { "optional": true },
    "@platformatic/kafka": { "optional": true }
  }
}
```

Confirmed the right class: both are opt-in, both have the library owning the abstraction while Bun owns the I/O
through `node:net`, and neither may be a `dependency`. `@node-rs/crc32` and `protobufjs` are `optionalDependencies` of
`@platformatic/kafka` and are not dunx's to declare. Nothing goes in `dependencies`, and no `ioredis`-style
mandatory-but-unused install is needed, since neither library statically imports something it documents as optional,
unlike bullmq 6.0.5.

**Manifest, build and docs:** two `exports` entries in `packages/infra/package.json`, which
`scripts/build-package.ts` turns into two build entrypoints; use `/new-package` for the subpath checklist. One guide
page per family under `docs/guide/`, since a broker binding is something a user configures. One architecture page,
`docs/architecture/message-brokers.md`, holding the librdkafka NAN linker failure, the drain measurement, the
`AbortError` teardown and the exit matrix. Both gated by `scripts/no-slop.test.ts`, so budget a `/docs-pass`.
`packages/infra/README.md` grows two rows. `PUBLISHED_REFERENCE` in `internal/docs/scripts/generate.ts` stays
unchanged, so the architecture page is repo-only.

**Examples and CI, and this is the real cost.** Every example must be in CI (`CLAUDE.md`, Examples), and
`examples/full` is the one that grows through the phases. So `examples/full` gains a producer and a consumer per
family, and CI has to run them, which means service containers in `ci.yml`. RabbitMQ is `rabbitmq:4-alpine`, ~50 s to pull cold and ~10 s to become healthy, and the example must declare durable
queues per the `transient_nonexcl_queues` refusal above. For Kafka, Redpanda is the cheaper subject, ~30 s to pull,
single node with `--smp 1 --memory 512M`, exposing 19092; Kafka with KRaft is heavier and buys nothing for a binding
test.

That is two more service containers on a job that today needs Redis, Postgres and MySQL, and roughly 60 to 90 s of
added wall time per run. The alternative is the existing pattern for an absent service: the example prints that it is
skipping and still exits 0, which keeps CI cheap but stops testing the binding, at which point the example is
documentation rather than a test. Pick the containers and pay the time, or accept that the broker path is unexercised.
That trade is the strongest single argument for waiting until a user is asking.

**Total, both families:** ~1685 source lines, ~1120 test lines, 14 new files, 1 file moved into `@dunx/core`,
2 optional peers, 3 docs pages, 1 example extended, 2 CI service containers.
