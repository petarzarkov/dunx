import { afterAll, beforeAll, expect, it } from 'bun:test';
import type { HttpApp } from '@dunx/http';
import { createApp } from './bootstrap.js';

/**
 * The queue is the one area the playground cannot demonstrate in a single process:
 * a worker is its own container with its own connections, so `bun run worker` is a
 * second process and this suite spawns it.
 *
 * Every assertion is skipped when Redis is unreachable, because `bun run test` has
 * to pass on a machine with nothing running — the same contract the cache routes
 * keep.
 */
const APP_DIR = new URL('..', import.meta.url).pathname;

let app: HttpApp;
let base: string;
let worker: Bun.Subprocess | undefined;
let queueUp = false;

const api = (path: string): URL => new URL(`api/${path}`, base);

beforeAll(async () => {
  app = await createApp();
  base = await app.listen(0);

  // One publish decides it: with no Redis the route answers 503 in milliseconds
  // rather than hanging, which is what makes this check cheap enough to do here.
  const probe = await fetch(api('jobs/thumbnails'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ width: 32, format: 'png' }),
  });
  queueUp = probe.status === 201;

  if (queueUp) {
    worker = Bun.spawn(['bun', 'src/worker.ts'], {
      cwd: APP_DIR,
      env: { ...process.env, NODE_ENV: 'production' },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    // The worker opens its own container and one bullmq Worker per queue.
    await Bun.sleep(2500);
  }
});

afterAll(async () => {
  worker?.kill('SIGTERM');
  await worker?.exited;
  await app.shutdown();
});

const enqueue = async (width: number): Promise<string> => {
  const response = await fetch(api('jobs/thumbnails'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ width, format: 'webp' }),
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as { id: string }).id;
};

interface JobView {
  readonly state: string;
  readonly result: { width: number } | null;
  readonly failedReason: string | null;
}

/**
 * Waits for the **result**, not merely a terminal state. bullmq reports a state
 * before `returnvalue` is necessarily readable, and a test that stopped at
 * `completed` would flake on exactly the assertion that matters.
 */
const settled = async (id: string): Promise<JobView> => {
  let last: JobView | undefined;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    last = (await (
      await fetch(api(`jobs/thumbnails/${id}`))
    ).json()) as JobView;
    if (last.result !== null || last.state === 'failed') return last;
    await Bun.sleep(150);
  }
  // Whatever went wrong, the worker's own output is the only place that says so.
  const output = worker
    ? await new Response(worker.stderr as ReadableStream).text()
    : '(no worker spawned)';
  throw new Error(
    `job ${id} never produced a result. last=${JSON.stringify(last)}\nworker stderr:\n${output.slice(0, 2000)}`,
  );
};

it('answers 503 rather than hanging when the queue is unreachable', async () => {
  if (queueUp) return;
  const response = await fetch(api('jobs/thumbnails'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ width: 32, format: 'png' }),
  });
  expect(response.status).toBe(503);
  const body = (await response.json()) as { error: string };
  expect(body.error).toContain('Queue unavailable');
});

it.if(process.env['SKIP_QUEUE_TESTS'] !== '1')(
  'publishes in the web process and consumes in the worker',
  async () => {
    if (!queueUp) return;

    const id = await enqueue(96);
    const finished = await settled(id);

    expect(finished.state).toBe('completed');
    // The result was computed in another process and read back through Redis,
    // which is the only thing this test is really asserting.
    expect(finished.result).toMatchObject({ width: 96 });
  },
  30_000,
);

it.if(process.env['SKIP_QUEUE_TESTS'] !== '1')(
  'returns 404 for a job id nobody enqueued',
  async () => {
    if (!queueUp) return;
    const response = await fetch(api('jobs/thumbnails/999999'));
    expect(response.status).toBe(404);
  },
  15_000,
);

it.if(process.env['SKIP_QUEUE_TESTS'] !== '1')(
  'rejects a width the schema does not allow, before publishing',
  async () => {
    if (!queueUp) return;
    const response = await fetch(api('jobs/thumbnails'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ width: 99999 }),
    });
    expect(response.status).toBe(400);
  },
  15_000,
);
