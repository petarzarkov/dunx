import { existsSync } from 'node:fs';
import { beforeAll, expect, it } from 'bun:test';

const APP_DIR = new URL('..', import.meta.url).pathname;

/**
 * The tour is the end-to-end check: it boots the same app `bun start` serves,
 * narrates every package and exits 0. Assertions read the structured entries
 * rather than raw stdout — `NODE_ENV=production` selects the plain JSON
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
  expect(tour.text).toContain('playground: users ready');
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
    'POST /api/notes -> 201, x-handled-by: request-logger',
  );
});

it('generates a JSON Schema from the same zod schema', () => {
  // `.meta({ id })` names the $defs entry — the slot OpenAPI calls
  // components/schemas — and `.meta({ title })` lands inline.
  expect(tour.text).toContain(
    '"$defs":{"Tag":{"type":"object","properties":{"label":{"type":"string",' +
      '"minLength":1}},"required":["label"],"additionalProperties":false,' +
      '"title":"A label attached to a user"}}',
  );
  expect(tour.text).toContain('"title":"Create a user"');
});

it('documents every route the one app serves', () => {
  expect(tour.text).toMatch(/GET \/api\/openapi\.json -> 200 openapi 3\.1\.0/);
  // Every area is reachable and therefore documented — that is what makes the
  // service explorable rather than a script.
  for (const path of [
    '/api/ledger',
    '/api/files/object',
    '/api/images/render',
    '/api/cache/{id}',
    '/api/health',
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
  // Every $ref resolves, and nothing degraded.
  expect(tour.text).toContain('unresolved $refs: 0, warnings: []');
});

it('serves a docs page that fetches nothing', () => {
  expect(tour.text).toMatch(
    /GET \/api\/docs -> 200 text\/html; charset=utf-8, \d+ bytes, 1 inline script, external requests: none/,
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
  // bun-sqlite transaction() cannot survive — hence @dunx/infra/db's.
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
});

it('serves HTTP and WebSocket from one Bun.serve', () => {
  expect(tour.text).toContain('gateway paths: ["/chat"]');
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
  expect(tour.text).toContain(
    'set("trust proxy", true): X-Forwarded-For sent -> 203.0.113.7',
  );
  expect(tour.text).toContain(
    'setGlobalPrefix() after listen() threw: setGlobalPrefix() must be called before listen().',
  );
});

it('tells middleware which route it was folded into', () => {
  // One entry per request, so the route it was folded into is a field on that
  // entry rather than a second line. RequestLog is the in-memory proof.
  expect(tour.text).toContain(
    'RequestLog -> ["GET /api/notes -> 200 (NotesController.list)"',
  );
});

it('enforces @Public, @Roles and a method-scoped @UseGuards', () => {
  // The controller-scoped guard runs, reads ctx.get(PUBLIC), and lets it past.
  expect(tour.text).toContain(
    'AuthGuard: GET /api/reports/health is @Public() — skipping',
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
    'AuthGuard: GET /api/users is @Public() — skipping',
  );
  expect(tour.text).toContain('GET /api/users -> 200 [{"id":1,"name":"ada"}');
});
