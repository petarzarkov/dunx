import { existsSync } from 'node:fs';
import { beforeAll, expect, it } from 'bun:test';

const APP_DIR = new URL('..', import.meta.url).pathname;

/**
 * The tour is the end-to-end check: it boots the same app `bun start` serves,
 * narrates every package and exits 0. Assertions read the structured entries,
 * `NODE_ENV=production` selecting the plain JSON formatter so there is no ANSI
 * to strip. Both streams are collected: `ConsoleTransport` sends warn and above
 * to stderr, and the degraded-cache line is a warning.
 */
const runTour = async (env: Record<string, string> = {}) => {
  const proc = Bun.spawn(['bun', 'src/tour.ts'], {
    cwd: APP_DIR,
    env: { ...process.env, NODE_ENV: 'production', ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  const messages = `${out}\n${err}`
    .split('\n')
    .filter((line) => line.startsWith('{'))
    .map((line) => String((JSON.parse(line) as { message: unknown }).message));

  return { code, messages, text: messages.join('\n') };
};

const tour = { text: '', messages: [] as string[], code: -1 };

/**
 * 20 s rather than the 5 s default. This hook boots the whole app in a process of
 * its own, narrates every package and waits for it to exit: 4.4 s on a laptop with
 * every service reachable, and a GitHub runner is 2 to 3 times slower. It failed
 * twice on the default while the rest of `bun run ci` ran beside it. A real hang
 * still fails, just later.
 */
beforeAll(async () => {
  Object.assign(tour, await runTour());
}, 20_000);

it('boots the whole graph and exits 0', () => {
  expect(tour.code).toBe(0);
  expect(tour.text).toContain('dunx-full: users ready');
  expect(tour.text).toContain('2 users: ada, grace');
  expect(tour.text).toContain('users draining');
  expect(tour.text).toContain('database closed');
});

it('serves the controllers it discovered', () => {
  expect(tour.text).toMatch(/tour listening on http:\/\/[^\s]+/);
  expect(tour.text).toContain(
    'GET /api/users -> 200 [{"id":1,"name":"ada"},{"id":2,"name":"grace"}]',
  );
  expect(tour.text).toContain(
    'setGlobalPrefix("api"): GET /api/notes -> 200 ' +
      '["read the architecture doc","measure before deciding"]',
  );
  expect(tour.text).toContain(
    'GET /notes -> 404 (the unprefixed path is gone)',
  );
});

it('validates zod schemas and wraps the return', () => {
  // 201 from the verb, not from a hand-built Response.
  expect(tour.text).toContain('POST /api/users -> 201 {"id":3,"name":"linus"}');
  // A rejected zod schema is a 400 carrying every issue, path flattened to dots.
  expect(tour.text).toContain(
    'POST /api/users {"name":42} -> 400 {"error":"Invalid body","status":400,' +
      '"issues":[{"message":"Invalid input: expected string, received number",' +
      '"path":"name"}]}',
  );
  expect(tour.text).toContain(
    'POST /api/users {"tags":[{"label":""}]} -> 400 {"error":"Invalid body",' +
      '"status":400,"issues":[{"message":"Too small: expected string to have ' +
      '>=1 characters","path":"tags.0.label"}]}',
  );
  // The params schema turned ":id" into a number before the handler ran, and the
  // query schema coerced "limit".
  expect(tour.text).toContain(
    'GET /api/users/1 -> 200 {"id":1,"name":"ada"} (params.id coerced to a number)',
  );
  expect(tour.text).toContain(
    'GET /api/users?limit=1&q=ad -> 200 [{"id":1,"name":"ada"}] (query coerced by zod)',
  );
  expect(tour.text).toContain(
    'POST /api/notes -> 201, x-handled-by: request-trail',
  );
});

it('generates a JSON Schema from the same zod schema', () => {
  // `.meta({ id })` names the $defs entry - the slot OpenAPI calls
  // components/schemas - and `.meta({ description })` lands inline beside it.
  //
  // The prose goes in `description`, never `title`: Swagger UI labels a schema by
  // its `title` when there is one and by its `components/schemas` key otherwise,
  // so a prose title makes the Schemas list read as sentences rather than type
  // names. Verified against Swagger UI 5.32.14.
  // zod 4.5 hoists the **root** into `$defs` too and leaves a `$ref` behind it,
  // where 4.4 emitted the root inline and only named children were hoisted. The
  // named child is still there; what moved is the top of the document.
  expect(tour.text).toContain('"$ref":"#/$defs/CreateUser"');
  expect(tour.text).toContain(
    '"Tag":{"type":"object","properties":{"label":{"type":"string",' +
      '"minLength":1}},"required":["label"],"additionalProperties":false,' +
      '"description":"A label attached to a user"}',
  );
  expect(tour.text).toContain('"description":"Create a user"');
});

it('documents every route the one app serves', () => {
  expect(tour.text).toMatch(/GET \/api\/openapi\.json -> 200 openapi 3\.1\.0/);
  // Every area is reachable and therefore documented - that is what makes the
  // service explorable rather than a script.
  for (const path of [
    '/api/ledger',
    '/api/files/object',
    '/api/images/render',
    '/api/cache/{id}',
    '/api/reports/{id}',
    '/api/users/{id}',
  ]) {
    expect(tour.text).toContain(`"${path}"`);
  }
  expect(tour.text).toContain(
    'POST /api/users requestBody -> {"$ref":"#/components/schemas/CreateUser"}',
  );
  // The framework's own 400 shape, documented rather than discovered.
  expect(tour.text).toContain(
    'POST /api/users 400 -> {"schema":{"$ref":"#/components/schemas/ValidationError"}}',
  );
  // Every $ref resolves.
  expect(tour.text).toContain('unresolved $refs: 0');
});

/**
 * **A real name collision, kept because it is instructive.** This app declares
 * `.meta({ id: 'User' })` for its users table and `betterAuthDocument` contributes
 * better-auth's `User`: two schemas, one `components/schemas` key.
 *
 * `SchemaStore.add` keeps the **generated** one and warns, rather than merging or
 * renaming, which would silently repoint a `$ref` a caller had already read. The
 * fix on a consumer's side is to rename one. This example does not, so the warning
 * stays and this test is what stops it becoming background noise.
 */
it('keeps the app schema when a contributor claims the same name', () => {
  // Quote-free fragments on purpose: the warning reaches the log line through two
  // rounds of JSON encoding, so any assertion carrying a quote is asserting on the
  // escaping rather than on the message.
  expect(tour.text).toContain('A contributor redefined the schema');
  expect(tour.text).toContain('The generated one was kept.');
  // The app's shape, not better-auth's: three properties from `users.schemas.ts`.
  expect(tour.text).toContain('"200":{"$ref":"#/components/schemas/User"}');
});

it('serves a Swagger UI shell whose assets resolve on this origin', () => {
  expect(tour.text).toMatch(
    /GET \/api\/docs -> 200 text\/html; charset=utf-8, \d+ bytes of Swagger UI shell/,
  );
  // Three assets, and the count that matters is the second number: every one is
  // served from the app rather than a CDN, which is the whole point of resolving
  // `swagger-ui-dist` out of the consumer's own install.
  expect(tour.text).toMatch(/requests 3 asset\(s\), 0 off-origin/);
  // All three answer, under the global prefix, with an immutable cache header.
  // The favicon is one of them: without it the browser asks for `/favicon.ico`
  // and the app logs a 404 of its own.
  for (const file of [
    'swagger-ui.css',
    'swagger-ui-bundle.js',
    'favicon-32x32.png',
  ]) {
    expect(tour.text).toContain(`/api/docs/${file} -> 200`);
  }
  expect(tour.text).toContain(
    'cache-control: public, max-age=31536000, immutable',
  );
});

/** The other renderer, over the same document, self-hosted the same way. */
it('serves a Scalar page whose one asset resolves on this origin', () => {
  expect(tour.text).toMatch(
    /GET \/api\/reference -> 200 text\/html; charset=utf-8, \d+ bytes of Scalar shell/,
  );
  expect(tour.text).toMatch(/requests 1 asset\(s\), 0 off-origin/);
  expect(tour.text).toContain('/api/reference/standalone.js -> 200');
  expect(tour.text).toContain('/api/reference/package.json -> 404');
});

it('documents security from the same metadata the guards read', () => {
  expect(tour.text).toContain(
    '@Roles("editor") PATCH /api/reports/{id} -> security [{"bearer":[]}], roles ["editor"]',
  );
  // An explicitly empty requirement, not a missing one.
  expect(tour.text).toContain(
    '@Public() GET /api/reports/health -> security []',
  );
  // Class-level metadata is merged into every route of the class.
  expect(tour.text).toContain(
    'class-level @Roles("admin") GET /api/reports -> security [{"bearer":[]}], roles ["admin"]',
  );
  expect(tour.text).toContain(
    'securitySchemes: {"bearer":{"type":"http","scheme":"bearer"',
  );
});

it('runs @dunx/infra/db on bun:sqlite at :memory:', () => {
  expect(tour.text).toContain(
    'backend=sqlite dialect=sqlite, table "ledger" created at onInit',
  );
  // DbConnection is the escape hatch: `.raw` is the bun:sqlite handle itself.
  expect(tour.text).toContain('raw driver -> bun:sqlite :memory:');
  // `.returning()` gives back the row the database wrote, id included.
  expect(tour.text).toMatch(
    /insert -> \{"id":\d+,"memo":"opening balance","amount":100\}/,
  );
  // drizzle's `.get()` reports a missing row as undefined, not null.
  expect(tour.text).toContain('get() with no match -> undefined');
  expect(tour.text).toMatch(/committed transaction -> \d+ rows, balance \d+/);
  // Both transactions await inside the callback, which is what drizzle's own
  // bun-sqlite transaction() cannot survive - hence @dunx/infra/db's.
  expect(tour.text).toContain('transaction threw: rolled back on purpose');
  expect(tour.text).toMatch(
    /rolled back transaction -> still \d+ rows, "discarded" never landed/,
  );
  // The journal is the point: onInit already applied them, so the tour's own
  // call reports them journaled and inserts nothing a second time.
  expect(tour.text).toContain(
    'runSeeds after onInit -> applied [], journaled ' +
      '["0001_ledger.seeder.ts","0002_production_audit.seeder.ts"], skipped []',
  );
  expect(tour.text).toMatch(/seeded ledger -> \d+ rows, applied once/);
});

it('runs @dunx/infra/files in a temp dir it removes on shutdown', () => {
  expect(tour.text).toContain('write  reports/q1.csv -> 22 bytes');
  expect(tour.text).toContain(
    'read   reports/q1.csv -> "quarter,amount\\nQ1,100\\n"',
  );
  expect(tour.text).toContain('stat   reports/q1.csv -> 22 bytes, text/csv');
  expect(tour.text).toContain(
    'glob   reports/*.csv -> ["reports/q1.csv","reports/q2.csv"]',
  );
  expect(tour.text).toContain('delete reports/q2.csv -> exists=false');
  expect(tour.text).toContain(
    'traversal rejected: Refusing "../../etc/passwd": it escapes the storage root',
  );
  expect(tour.text).toContain(
    'presign refused: LocalStorage does not support presign()',
  );

  // Nothing was written inside the repo, and the directory is gone.
  const root = /workspace removed: (\S+)/.exec(tour.text)?.[1];
  expect(root).toBeDefined();
  expect(root).not.toContain(APP_DIR);
  expect(existsSync(root as string)).toBe(false);
});

it('runs @dunx/infra/images on a source it generates at runtime', () => {
  expect(tour.text).toMatch(
    /generated a 64x48 source from the 4x4 seed at runtime: \d+ bytes, detected png/,
  );
  expect(tour.text).toContain('metadata -> 64x48 png');
  expect(tour.text).toMatch(/resize 16x16 inside -> 16x12 png, \d+ bytes/);
  expect(tour.text).toMatch(
    /convert 32px wide -> 32x24 image\/webp, \d+ bytes/,
  );
  expect(tour.text).toContain(
    'the pipeline is immutable: the source is still 64x48 png',
  );
});

it('reaches redis, or says it is skipping it', () => {
  expect(tour.text).toMatch(/(PING \S+ -> PONG|skipping redis at \S+)/);
});

it('serves a cached read and dedupes the concurrent ones', () => {
  expect(tour.text).toMatch(
    /store -> (L1 memory in front of L2 redis|L1 memory only, redis unreachable at boot), metered, default ttl 30000ms/,
  );
  expect(tour.text).toContain(
    '10 concurrent reads of an uncached key -> 1 load (single flight, per process)',
  );
  expect(tour.text).toMatch(
    /DELETE -> \{"evicted":true\}, the next read loads again/,
  );
});

it('exits 0 with no redis at all', async () => {
  const run = await runTour({ REDIS_URL: 'redis://127.0.0.1:1' });

  expect(run.code).toBe(0);
  expect(run.text).toMatch(/skipping redis at redis:\/\/127\.0\.0\.1:1/);
  expect(run.text).toContain(
    'a cache that is not running must not fail the app',
  );
  // Everything after the cache still ran.
  expect(run.text).toContain('2 users: ada, grace');
  // The websocket relay points at the same dead url, so the app boots, warns,
  // and fans out locally - and the process still exits, which is what `code`
  // being 0 proves.
  expect(run.text).toContain(
    'skipping the relay demo: no Redis to relay through',
  );
  expect(run.text).toContain(
    'the app booted anyway and fan-out stayed local - that is the degraded path',
  );
  expect(run.text).toMatch(/the websocket relay could not (subscribe|publish)/);
  // `CacheIndicator` overrides `critical` to false, so a cache that is down is
  // reported and does not shed traffic. This is that override, observed.
  expect(run.text).toMatch(/redis=down/);
  expect(run.text).toMatch(/GET \/api\/health\/ready -> 200 up/);
  expect(run.text).toContain(
    'non-critical and down: redis - readiness is still up',
  );
});

it('probes liveness and readiness, and takes the pod out by hand', () => {
  // Liveness is a memory ceiling and nothing else: it answers "restart me",
  // which a database being unreachable is not an answer to.
  expect(tour.text).toMatch(
    /GET \/api\/health\/live -> 200 up, \d+ ms up, memory=up/,
  );
  // Readiness is the four checks `IndicatorsModule` declares, in order.
  expect(tour.text).toMatch(
    /GET \/api\/health\/ready -> 200 up, \d+ ms up, database=up ledger=up redis=\w+ disk=up/,
  );
  // hold() fails readiness while liveness keeps passing - a pod that is being
  // migrated does not need killing.
  expect(tour.text).toContain(
    'readiness.hold("migrating") -> ready 503 migrating, live still 200',
  );
  expect(tour.text).toContain('readiness.release() -> ready 200');
});

it('counts and times every request the tour already made', () => {
  // `metrics: true` on HttpFactory.create, folded into the entry request logging
  // already builds - so these numbers are a by-product of work the app did.
  expect(tour.text).toMatch(
    /\d+ route series, \d+ in flight, \d+ sockets - both read off Bun\.serve, not counted/,
  );
  expect(tour.text).toMatch(
    /GET \/api\/\S+: \d+ calls, p50 [\d.]+ms p99 [\d.]+ms max [\d.]+ms/,
  );
  // The exemplar joins the percentile back to the request's own log lines.
  expect(tour.text).toMatch(
    /the slowest \/api\/\S+ call has traceId [0-9a-f]{32}/,
  );
});

it('keeps one series per route pattern, and one for every miss', () => {
  expect(tour.text).toMatch(
    /unmatched paths: \d+ across one series, so a scanner walking urls cannot grow/,
  );
});

it('gives each rpc a series of its own, not the miss bucket', () => {
  const seen = /(\d+) rpc series over (\d+) mounted methods/.exec(tour.text);
  expect(Number(seen?.[1])).toBeGreaterThan(0);
  expect(seen?.[1]).toBe(seen?.[2]);
});

it('times queries at the driver, since drizzle cannot time one', () => {
  expect(tour.text).toMatch(
    /\d+ queries, timed at the bun:sqlite handle dunx constructs/,
  );
  expect(tour.text).toMatch(/select: \d+ calls, \d+ failed, p99 [\d.]+ms/);
});

it('times every redis command at the one seam, and keeps no key', () => {
  expect(tour.text).toMatch(
    /\d+ redis commands across \d+ verbs, \d+ failed - timed at the one seam/,
  );
  // The verb is the whole key: `QueryMetrics` keeps a redacted statement for its
  // slowest, and the Redis analogue would be a key nothing can redact.
  expect(tour.text).toMatch(
    /[A-Z]+: \d+ calls, p99 .+ - the key is never kept/,
  );
});

it('reports the publish side, and only handlers this process ran', () => {
  expect(tour.text).toMatch(/\d+ jobs published, \d+ handled in this process/);

  // The forked handler is the scope limit, stated by the numbers: its enqueue is
  // this container's and its duration belongs to the child that ran it.
  expect(tour.text).toMatch(
    /thumbnails\/render: published \d+ \(p99 [^)]+\), handled 0/,
  );
  expect(tour.text).toContain(
    'a background handler runs in a forked child with its own container',
  );

  const handled = tour.messages.some((line) =>
    line.includes('audited 96x72 in this process'),
  );
  if (handled) {
    expect(tour.text).toMatch(
      /thumbnail-audit\/record: published \d+ \(p99 [^)]+\), handled 1 \(p99 [\d.]+ms\)/,
    );
  }
});

it('samples event-loop lag from boot rather than from the first read', () => {
  // `EventLoopLag` is a provider, so `onInit` enabled it before any of this ran.
  expect(tour.text).toMatch(
    /event loop lag: \d+ samples, p99 [\d.]+ms max [\d.]+ms/,
  );
});

it('serves the stats panel over the ops page, cache half included', () => {
  expect(tour.text).toMatch(/cache: \d+ hits, \d+ misses, hit rate [\d.]+%/);
});

it('lights the same indicators on the ops page, each once', () => {
  // `IndicatorsModule` declares them and both readers take that list, so the
  // dashboard names every check `/api/health/ready` runs. `redis` appears once:
  // `DashboardOptions.redis` already contributes it, which is why
  // `AppIndicators.dashboardProbes` drops `CacheIndicator`.
  expect(tour.text).toMatch(/probes: redis=\w+ database=up ledger=up disk=up/);
});

it('documents the probes under one Health tag', () => {
  // Documented by default. `tagOf` strips the `Controller` suffix, so both
  // operations land under `Health` rather than under `HealthController`.
  expect(tour.text).toContain('"/api/health/live"');
  expect(tour.text).toContain('"/api/health/ready"');
});

it('refuses the fourth request and exempts what opted out', () => {
  // Redis when it answers, memory when it does not, and the limit works either
  // way - which is what keeps this section meaningful on a machine with no Redis.
  expect(tour.text).toMatch(
    /rate limit counting in (redis at \S+, shared by every replica|memory: \S+ is unreachable)/,
  );
  expect(tour.text).toContain(
    '@Throttle({ limit: 3, windowSeconds: 60 }) x4 -> 200, 200, 200, 429',
  );
  // The headers a client needs to back off, not just the status.
  expect(tour.text).toContain('ratelimit-remaining per attempt -> 2, 1, 0, 0');
  expect(tour.text).toMatch(/the 4th carries retry-after: \d+s/);
  expect(tour.text).toContain(
    '@SkipThrottle() x6 -> 200, 200, 200, 200, 200, 200 (not counted at all)',
  );
  // The window belongs to the subject, which is what `subject` decides.
  expect(tour.text).toContain('same route, different x-api-key -> 200');
});

it('serves static assets with two cache policies', () => {
  expect(tour.text).toContain('cache-control: public, max-age=60');
  // Only a content-addressed name gets the forever promise.
  expect(tour.text).toMatch(
    /app\.a1b2c3d4\.js -> 200 text\/javascript.*immutable/,
  );
  expect(tour.text).toContain(
    'GET /assets/../../package.json -> 404 (never leaves the root)',
  );
  // Anything outside the mount falls through untouched.
  expect(tour.text).toContain('GET /api/notes -> 200 (outside /assets');
});

it('reaches a second outbound client through a constructor parameter', () => {
  // `HealthClient extends HttpService`, registered with `forRootAsync(config,
  // HealthClient)`. A subclass is a token and a parameter type, so `UpstreamDemo`
  // takes it as an argument - `httpClient('health')` would return a `Token`, and
  // a token can only be reached with `inject()` in a field.
  expect(tour.text).toContain('HealthClient -> up');
});

it('retries an outbound 503, and does not retry a 404 or an abort', () => {
  expect(tour.text).toContain(
    'two 503s then a 200 -> attempts 1, 2 (retry), 3 (retry), recovered after 3',
  );
  // A FetchError rather than an HttpError, so an upstream status is not passed on.
  expect(tour.text).toContain('404 -> FetchError status 404');
  expect(tour.text).toContain(
    'timeoutMs: 25 against a 300 ms route -> FetchTransportError',
  );
});

it('runs the same upstream through a ResiliencePolicy, with a fallback', () => {
  // Core owns the loop, `HttpRetryClassifier` owns the verdict on a status.
  expect(tour.text).toContain(
    'ResiliencePolicy retried the 503s itself -> recovered after 3',
  );
  // A 404 is not retried, so the attempts are spent and the fallback answers.
  expect(tour.text).toContain('ResiliencePolicy on a 404 -> cached=true');
  // The client is given no budget for this one, so the abort can only come from
  // the signal `run` handed the attempt. A callback that dropped it would answer
  // `done` 300 ms later, and the demo raises rather than logging this line.
  expect(tour.text).toContain(
    'ResiliencePolicy timeoutMs against a 300 ms route -> cached=true',
  );
});

it('arms three schedules and triggers two off their cadence', () => {
  expect(tour.text).toContain('once     maintenance.warm at 0');
  expect(tour.text).toContain('interval maintenance.sweep at 600000');
  expect(tour.text).toMatch(
    /cron {5}maintenance\.compact at 0 3 \* \* \* - next \d{4}-/,
  );
  // @OnceOnBoot(0) fires before listen() resolves.
  expect(tour.text).toContain('@OnceOnBoot fired at boot -> warmed=true');
  expect(tour.text).toContain(
    'trigger() x2 -> 1 compaction, 1 sweep, neither waited for a clock',
  );
  expect(tour.text).toContain(
    'runs recorded on the entry -> 1, lastError none',
  );
});

it('publishes an event and waits out every subscriber', () => {
  // Five @OnEvent methods, none of them named by the publisher's module.
  expect(tour.text).toContain('OrderPlaced   <- Audit.record');
  expect(tour.text).toContain('OrderSettled  <- Notifications.countSettled');
  // EventsModule is imported before EventBusModule, so wiring cannot be waiting
  // for `onInit` - the boot emit would reach nobody if it were.
  expect(tour.text).toContain(
    'emit(AppReady) from onInit reached 1 subscriber(s), with EventBusModule ' +
      'imported last',
  );
  expect(tour.text).toContain('emit(OrderPlaced) -> 3 handled, 0 failed');
  // The async handler's row and the sync handler's waitUntil work both landed
  // before `await emit(...)` returned, and a handler published in turn.
  expect(tour.text).toContain(
    'after await: 1 audit row(s), 1 notification(s), 1 OrderSettled seen',
  );
});

it('contains a throwing subscriber and keeps the rest running', () => {
  expect(tour.text).toContain(
    'Notifications.flagForReview threw, and the dispatch carried it: ' +
      'Error: order-2 is over the 1000 review limit',
  );
  expect(tour.text).toContain(
    'the other subscribers still ran -> 2 handled, 2 audit rows in total',
  );
  expect(tour.text).toContain('on() saw 1, then unsubscribe() -> active=false');
  expect(tour.text).toContain(
    '@OnEvent({ once: true }) fired 1 time(s) across 4 settlements',
  );
});

it('serves HTTP and WebSocket from one Bun.serve', () => {
  expect(tour.text).toContain('gateway paths: ["/chat","/telemetry"]');
  expect(tour.text).toContain('two clients connected: welcome / welcome');
  expect(tour.text).toContain(
    'grace <- {"event":"said","data":"one server, two protocols"}',
  );
  expect(tour.text).toContain('"lobby" subscribers: 2');
  expect(tour.text).toContain(
    'the same server still answers GET /api/notes -> 200',
  );
  expect(tour.text).toContain('/chat closed with 1000');
});

it('serves the same routes over HTTP/2 and HTTP/1.1 on one port', () => {
  // node:http2 opens with the connection preface, so a 200 here is the wire
  // protocol rather than an option having been stored. Bun's own fetch will not
  // speak h2c, which is why the demo does not use it.
  expect(tour.text).toMatch(
    /GET \/api\/notes over HTTP\/2 -> 200, \d+ bytes \(h2c, prior knowledge/,
  );
  expect(tour.text).toContain(
    'GET /api/notes over HTTP/1.1 -> 200, same port, same routes',
  );
});

it('refuses http1: false with a gateway, and serves both once ports split', () => {
  // The boot error names the stranded path rather than starting an app whose
  // gateways nothing could reach.
  expect(tour.text).toContain(
    'nothing could ever connect to /telemetry. Set gatewayPort',
  );
  expect(tour.text).toMatch(
    /routes on \d+ \(HTTP\/2 only\), gateways on \d+ \(HTTP\/1\.1\) - one container, two servers/,
  );
  // The status, not just the line: the demo logs whatever it got, so without
  // this the test passes when the routes port answers 200.
  expect(tour.text).toContain('GET / on the routes port over HTTP/1.1 -> 505');
  expect(tour.text).toContain(
    'the gateway accepted an upgrade on its own port',
  );
});

it('delivers a binary frame as the configured binaryType', () => {
  // Bun's default is a Buffer; 'blob' is what main.ts asked for, and 1.4.1 is
  // what added it to the three a server socket already took.
  expect(tour.text).toContain(
    'telemetry <- Blob(3) -> [21, 34, 55], 3 recorded',
  );
});

it('serves protobuf over Connect and gRPC-Web on the port the routes use', () => {
  // The greeted count comes off the injected Greetings provider, so a passing
  // line here means the RPC was constructed by the container.
  expect(tour.text).toContain(
    'connect unary -> Hello connect (greeted 1 so far)',
  );
  expect(tour.text).toContain(
    'connect server stream -> tick 3, tick 2, tick 1',
  );
  expect(tour.text).toContain(
    'grpc-web unary -> Hello grpc-web on the same port',
  );
  // The Connect protocol is a plain POST, so no generated client is required.
  expect(tour.text).toContain('plain JSON POST -> 200 {"text":"Hello curl"');
});

it('maps a thrown ConnectError to a status and refuses native gRPC', () => {
  expect(tour.text).toContain(
    'a thrown ConnectError arrives as a status -> ConnectError: [invalid_argument] name is required',
  );
  // gRPC puts grpc-status in an HTTP trailer and Bun.serve sends none, so the
  // refusal is explicit rather than a reply the client would misread.
  expect(tour.text).toContain(
    'native gRPC content-type -> 415 unimplemented (Connect and gRPC-Web only)',
  );
});

it('logs an RPC through the same request logger as a route', () => {
  // The reason this is middleware and not a second server on a second port.
  expect(tour.text).toContain('POST /greet.v1.GreetService/Say 200');
});

it('fans a publish out to a second node exactly once, or says it is skipping', () => {
  // Exactly one delivery per client is the assertion that matters: Redis echoes a
  // publish back to the node that made it, and fanning that out again would
  // deliver twice to every client on the publishing node.
  expect(tour.text).toMatch(
    /(deliveries of "across nodes": A 1, B 1|skipping the relay demo: no Redis to relay through)/,
  );
});

it('answers a preflight and denies an unknown origin', () => {
  expect(tour.text).toContain(
    'enableCors: OPTIONS from https://example.com -> 204 ' +
      'allow-origin=https://example.com allow-methods=GET, POST ' +
      'allow-headers=content-type allow-credentials=true max-age=600',
  );
  // No CORS headers at all is what makes a browser block it.
  expect(tour.text).toContain(
    'OPTIONS from https://evil.test -> 204 allow-origin=- allow-methods=- ' +
      'allow-headers=- allow-credentials=- max-age=-',
  );
});

it('honours trust proxy and refuses a hook after listen()', () => {
  // The header is `203.0.113.7, 10.0.0.1` and one hop is trusted, so the answer
  // is the entry the proxy appended. `203.0.113.7` is whatever the caller typed.
  expect(tour.text).toContain(
    'set("trust proxy", true): X-Forwarded-For sent -> 10.0.0.1',
  );
  expect(tour.text).toContain(
    'setGlobalPrefix() after listen() threw: setGlobalPrefix() must be called before listen().',
  );
});

it('tells middleware which route it was folded into', () => {
  // One entry per request, so the route it was folded into is a field on that
  // entry rather than a second line. RequestTrail is the in-memory proof.
  expect(tour.text).toContain(
    'RequestTrail -> ["GET /api/notes -> 200 (NotesController.list)"',
  );
});

it('enforces @Public, @Roles and a method-scoped @UseGuards', () => {
  // The controller-scoped guard runs, reads ctx.get(PUBLIC), and lets it past.
  expect(tour.text).toContain(
    'AuthGuard: GET /api/reports/health is @Public() - skipping',
  );
  expect(tour.text).toContain(
    '@Public() GET /api/reports/health, no credentials -> 200 {"ok":true}',
  );
  expect(tour.text).toContain(
    'GET /api/reports, no credentials -> 401 {"error":"No credentials","status":401}',
  );
  expect(tour.text).toContain(
    'GET /api/reports as "viewer" -> 200 ["q1 revenue"]',
  );

  // @UseGuards(RolesGuard) at method scope, reading the class-level @Roles('admin').
  expect(tour.text).toContain(
    '@UseGuards(RolesGuard) POST /api/reports as "viewer" -> 403 ' +
      '{"error":"Requires one of: admin","status":403}',
  );
  expect(tour.text).toContain(
    'POST /api/reports as "admin" (class-level @Roles) -> 201 ' +
      '["q1 revenue","q2 revenue"]',
  );

  // A method-level @Roles overrides the class-level one, both directions proven.
  expect(tour.text).toContain(
    'PATCH /api/reports/1 as "admin" (method-level @Roles("editor") won) -> 403 ' +
      '{"error":"Requires one of: editor","status":403}',
  );
  expect(tour.text).toContain(
    'PATCH /api/reports/1 as "editor" -> 200 ' +
      '["q1 revenue, restated","q2 revenue"]',
  );
});

it('leaves every other route reachable without credentials', () => {
  // The whole reason AuthGuard is on the controller rather than global.
  expect(tour.text).not.toContain(
    'AuthGuard: GET /api/users is @Public() - skipping',
  );
  expect(tour.text).toContain('GET /api/users -> 200 [{"id":1,"name":"ada"}');
});

/**
 * The Postgres backend, which was named in a comment and called by nothing until
 * the soak audit went looking. Both halves are asserted: fan-out reaching the
 * other node exactly once, and the 7999-byte `NOTIFY` cap degrading to a local
 * delivery plus a warning rather than a silent drop.
 */
it('relays over Postgres LISTEN/NOTIFY, and reports a frame over the cap', () => {
  expect(tour.text).toMatch(
    /(deliveries: A 1, B 1|skipping the Postgres relay demo)/,
  );
  if (tour.text.includes('skipping the Postgres relay demo')) return;
  expect(tour.text).toContain('two nodes on LISTEN/NOTIFY');
  // A keeps it, B never sees it, and the relay says why.
  expect(tour.text).toContain('a 9000-byte frame: A 1, B 0');
  expect(tour.text).toMatch(/the websocket relay could not publish/);
});

/**
 * `overlap: 'skip'` is the default and every other schedule here takes it, so the
 * concurrent branch had no exercise at all. Two triggers inside one run's own
 * sleep: `skip` would hold this at one in flight.
 */
it('runs a concurrent-overlap schedule twice at once', () => {
  expect(tour.text).toContain(
    'overlap: concurrent -> 2 runs, 2 in flight at once',
  );
});

it('narrates the queue, which spans two processes', () => {
  expect(tour.text).toContain(
    '@dunx/infra/queue - bullmq over Bun.RedisClient, the handler forked',
  );

  // With a broker the job completes elsewhere; without one the step says so and
  // the tour still exits 0.
  const published = tour.messages.some((line) =>
    line.includes('published render to thumbnails as job'),
  );
  const skipped = tour.messages.some((line) =>
    line.includes('no broker reachable - skipping the queue'),
  );
  expect(published || skipped).toBe(true);

  if (published) {
    expect(tour.text).toContain(
      'completed in a process this one never started',
    );
    // The other half of the pair: a handler with no `background`, which runs
    // wherever the queue is consumed - here, in this container.
    expect(tour.text).toContain('audited 96x72 in this process');
    expect(tour.text).toContain('ran in this process, so its handler duration');
  }
});

/**
 * Both halves of an event stream in one step: `@Sse` writes one,
 * `HttpService.streamSse` reads it back, and `app.use(Compression)` sits in front
 * of both.
 */
it('serves an event stream and reads its own back', () => {
  expect(tour.text).toContain(
    '@Sse -> streamSseEvents read 3 events: ticks 1, 2, 3',
  );
  // The envelope, not just the payload: `streamSse` yields the data alone.
  expect(tour.text).toContain(
    'the last one arrived whole: event=tick id=3 data={"tick":3}',
  );
  // The id of the last event seen, sent back the way an EventSource does.
  expect(tour.text).toContain('Last-Event-ID: 3 -> resumed at tick 4');
});

it('leaves the event stream unencoded, and frames it per event', () => {
  expect(tour.text).toContain(
    'content-type: text/event-stream, content-encoding: identity',
  );
  // The comment Bun wants before it will flush the headers.
  expect(tour.text).toContain('opens with ":", a comment line');
  expect(tour.text).toContain('event: tick / id: 1 / data: {"tick":1}');
});

it('pushes into a stream the handler kept, and drops it on disconnect', () => {
  expect(tour.text).toContain(
    'SseStream, 1 subscriber, pushed: event: notice / data: ' +
      '{"message":"deploy finished"}',
  );
  expect(tour.text).toContain('the client left -> 0 subscribers');
});
