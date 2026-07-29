import { existsSync } from 'node:fs';
import { beforeAll, expect, it } from 'bun:test';

const APP_DIR = new URL('..', import.meta.url).pathname;

const start = (env: Record<string, string> = {}) => {
  const proc = Bun.spawn(['bun', 'src/main.ts'], {
    cwd: APP_DIR,
    env: { ...process.env, ...env },
    stdout: 'pipe',
    stderr: 'inherit',
  });

  const output = { text: '' };
  const decoder = new TextDecoder();
  const drained = (async () => {
    for await (const chunk of proc.stdout)
      output.text += decoder.decode(chunk, { stream: true });
  })();

  return {
    output,
    async waitFor(marker: string): Promise<void> {
      while (!output.text.includes(marker)) await Bun.sleep(20);
    },
    async finish(): Promise<number> {
      const code = await proc.exited;
      await drained;
      return code;
    },
    kill: (signal: NodeJS.Signals) => proc.kill(signal),
  };
};

// One boot serves every assertion that only reads stdout. The two runs that need
// a different environment — a signal, an unreachable cache — spawn their own.
const app = { text: '', code: -1 };

beforeAll(async () => {
  const run = start();
  app.code = await run.finish();
  app.text = run.output.text;
});

it('boots the whole graph and exits 0', () => {
  expect(app.code).toBe(0);
  // Phase 1 assertions, unchanged by the arrival of HTTP and @dunx/infra.
  expect(app.text).toContain('playground: users ready');
  expect(app.text).toContain('2 users: ada, grace');
  expect(app.text).toContain('users draining');
  expect(app.text).toContain('database closed');
});

it('serves the controllers it discovered', () => {
  expect(app.text).toMatch(/listening on http:\/\/[^\s]+/);
  expect(app.text).toContain(
    'GET /api/users -> 200 [{"id":1,"name":"ada"},{"id":2,"name":"grace"}]',
  );
  expect(app.text).toContain(
    'setGlobalPrefix("api"): GET /api/notes -> 200 ' +
      '["read the architecture doc","measure before deciding"]',
  );
  expect(app.text).toContain('GET /notes -> 404 (the unprefixed path is gone)');
});

it('validates zod schemas and wraps the return', () => {
  // 201 from the verb, not from a hand-built Response.
  expect(app.text).toContain('POST /api/users -> 201 {"id":3,"name":"linus"}');
  // A rejected zod schema is a 400 carrying every issue, path flattened to dots.
  expect(app.text).toContain(
    'POST /api/users {"name":42} -> 400 {"error":"Invalid body","status":400,' +
      '"issues":[{"message":"Invalid input: expected string, received number",' +
      '"path":"name"}]}',
  );
  expect(app.text).toContain(
    'POST /api/users {"tags":[{"label":""}]} -> 400 {"error":"Invalid body",' +
      '"status":400,"issues":[{"message":"Too small: expected string to have ' +
      '>=1 characters","path":"tags.0.label"}]}',
  );
  // The params schema turned ":id" into a number before the handler ran, and the
  // query schema coerced "limit".
  expect(app.text).toContain(
    'GET /api/users/1 -> 200 {"id":1,"name":"ada"} (params.id coerced to a number)',
  );
  expect(app.text).toContain(
    'GET /api/users?limit=1&q=ad -> 200 [{"id":1,"name":"ada"}] (query coerced by zod)',
  );
  // 201 from the route's explicit `status`, and the same 400 shape from zod.
  expect(app.text).toContain(
    'POST /api/notes -> 201, x-handled-by: request-logger',
  );
  expect(app.text).toContain(
    'POST /api/notes {"text":7} -> 400 {"error":"Invalid body","status":400,' +
      '"issues":[{"message":"Invalid input: expected string, received number",' +
      '"path":"text"}]}',
  );
});

it('generates a JSON Schema from the same zod schema', () => {
  // `.meta({ id })` names the $defs entry — the slot OpenAPI calls
  // components/schemas — and `.meta({ title })` lands inline.
  expect(app.text).toContain(
    '"$defs":{"Tag":{"type":"object","properties":{"label":{"type":"string",' +
      '"minLength":1}},"required":["label"],"additionalProperties":false,' +
      '"title":"A label attached to a user"}}',
  );
  expect(app.text).toContain('"title":"Create a user"');
});

it('runs @dunx/infra/db on bun:sqlite at :memory:', () => {
  expect(app.text).toContain(
    'backend=sqlite dialect=sqlite, table "ledger" created',
  );
  expect(app.text).toContain('insert -> changes=1 lastInsertRowid=1');
  expect(app.text).toContain(
    'select -> [{"memo":"opening balance","amount":100},{"memo":"coffee","amount":-3}]',
  );
  expect(app.text).toContain('committed transaction -> 3 rows, balance 109');
  expect(app.text).toContain('transaction threw: rolled back on purpose');
  expect(app.text).toContain(
    'rolled back transaction -> still 3 rows, "discarded" never landed',
  );
});

it('runs @dunx/infra/files in a temp dir it removes on shutdown', () => {
  expect(app.text).toContain('write  reports/q1.csv -> 22 bytes');
  expect(app.text).toContain(
    'read   reports/q1.csv -> "quarter,amount\\nQ1,100\\n"',
  );
  expect(app.text).toContain('stat   reports/q1.csv -> 22 bytes, text/csv');
  expect(app.text).toContain(
    'glob   reports/*.csv -> ["reports/q1.csv","reports/q2.csv"]',
  );
  expect(app.text).toContain('delete reports/q2.csv -> exists=false');
  expect(app.text).toContain(
    'traversal rejected: Refusing "../../etc/passwd": it escapes the storage root',
  );
  expect(app.text).toContain(
    'presign refused: LocalStorage does not support presign()',
  );

  // Nothing was written inside the repo, and the directory is gone.
  const root = /workspace removed: (\S+)/.exec(app.text)?.[1];
  expect(root).toBeDefined();
  expect(root).not.toContain(APP_DIR);
  expect(existsSync(root as string)).toBe(false);
});

it('runs @dunx/infra/images on a source it generates at runtime', () => {
  expect(app.text).toMatch(
    /generated a 64x48 source from the 4x4 seed at runtime: \d+ bytes, detected png/,
  );
  expect(app.text).toContain('metadata -> 64x48 png');
  expect(app.text).toMatch(/resize 16x16 inside -> 16x12 png, \d+ bytes/);
  expect(app.text).toMatch(/convert 32px wide -> 32x24 image\/webp, \d+ bytes/);
  expect(app.text).toContain(
    'the pipeline is immutable: the source is still 64x48 png',
  );
});

it('reaches redis, or says it is skipping it', () => {
  expect(app.text).toMatch(/(PING \S+ -> PONG|skipping redis at \S+)/);
});

it('exits 0 with no redis at all', async () => {
  const run = start({ REDIS_URL: 'redis://127.0.0.1:1' });
  const code = await run.finish();

  expect(code).toBe(0);
  expect(run.output.text).toMatch(/skipping redis at redis:\/\/127\.0\.0\.1:1/);
  expect(run.output.text).toContain(
    'a cache that is not running must not fail the app',
  );
  // Everything after the cache still ran.
  expect(run.output.text).toContain('2 users: ada, grace');
});

it('serves HTTP and WebSocket from one Bun.serve', () => {
  expect(app.text).toContain('gateway paths: ["/chat"]');
  expect(app.text).toContain('two clients connected: welcome / welcome');
  expect(app.text).toContain(
    'grace <- {"event":"said","data":"one server, two protocols"}',
  );
  expect(app.text).toContain(
    'ada   <- {"event":"say","data":{"delivered":51}}',
  );
  expect(app.text).toContain('"lobby" subscribers: 2');
  expect(app.text).toContain(
    'the same server still answers GET /api/notes -> 200',
  );
  expect(app.text).toContain('/chat closed with 1000');
});

it('answers a preflight and denies an unknown origin', () => {
  expect(app.text).toContain(
    'enableCors: OPTIONS from https://example.com -> 204 ' +
      'allow-origin=https://example.com allow-methods=GET, POST ' +
      'allow-headers=content-type allow-credentials=true max-age=600',
  );
  // No CORS headers at all is what makes a browser block it.
  expect(app.text).toContain(
    'OPTIONS from https://evil.test -> 204 allow-origin=- allow-methods=- ' +
      'allow-headers=- allow-credentials=- max-age=-',
  );
});

it('honours trust proxy both ways and refuses a hook after listen()', () => {
  expect(app.text).toContain(
    'set("trust proxy", true): X-Forwarded-For sent -> 203.0.113.7',
  );
  expect(app.text).toMatch(
    /set\("trust proxy", false\): X-Forwarded-For sent -> (?!203\.0\.113\.7)/,
  );
  expect(app.text).toContain(
    'setGlobalPrefix() after listen() threw: setGlobalPrefix() must be called before listen().',
  );
});

it('closes cleanly on SIGTERM', async () => {
  const run = start({ DUNX_HOLD: '1' });
  await run.waitFor('holding');
  run.kill('SIGTERM');
  const code = await run.finish();

  expect(code).toBe(0);
  // Reverse dependency order: the service drains before the database it needs.
  expect(run.output.text.indexOf('users draining')).toBeLessThan(
    run.output.text.indexOf('database closed'),
  );
  // The temp dir is removed on the signal path too.
  expect(run.output.text).toContain('workspace removed:');
});
