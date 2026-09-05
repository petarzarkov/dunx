import { existsSync } from 'node:fs';
import { beforeAll, expect, it } from 'bun:test';

const APP_DIR = new URL('..', import.meta.url).pathname;

/**
 * The tour is the end-to-end check: it boots the same app `bun start` serves,
 * narrates every package and exits 0. Assertions read the structured entries
 * rather than raw stdout - `NODE_ENV=production` selects the plain JSON
 * formatter, so there is no ANSI to strip and a message containing a comma is
 * not broken up by the colouriser.
 *
 * Both streams are collected: `ConsoleTransport` sends warn and above to stderr
 * so a log shipper can separate them, and the degraded-cache line is a warning.
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

beforeAll(async () => {
  Object.assign(tour, await runTour());
});

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
 * `.meta({ id: 'User' })` for its own users table, and `betterAuthDocument`
 * contributes better-auth's `User` under the same name. Two different schemas, one
 * `components/schemas` key.
 *
 * dunx neither merges them nor renames one: `SchemaStore.add` keeps the **generated**
 * schema - the app's own - and warns, because renaming would silently repoint a
 * `$ref` a caller had already read. That precedence is the thing worth pinning: an
 * app's own document wins over a contributor's.
 *
 * The fix on a consumer's side is to name one of them differently. This example does
 * not, so the warning stays and this test is what stops it becoming background noise.
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

it('times queries at the driver, since drizzle cannot time one', () => {
  expect(tour.text).toMatch(
    /\d+ queries, timed at the bun:sqlite handle dunx constructs/,
  );
  expect(tour.text).toMatch(/select: \d+ calls, \d+ failed, p99 [\d.]+ms/);
});

it('samples event-loop lag from boot rather than from the first read', () => {
  // `EventLoopLag` is a provider, so `onInit` enabled it before any of this ran.
  expect(tour.text).toMatch(
    /event loop lag: \d+ samples, p99 [\d.]+ms max [\d.]+ms/,
  );
});

it('serves the stats panel over the ops page', () => {
  expect(tour.text).toContain('stats -> http configured, db configured');
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
