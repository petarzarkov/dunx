import { afterAll, beforeAll, expect, it } from 'bun:test';
import type { HttpApp } from '@dunx/http';
import { createApp } from './bootstrap.js';

/**
 * **No second process to spawn.** `JobsModule` sets `consume: true`, so building the
 * app is enough: the container opens the workers at `onInit`, and the thumbnail
 * queue's handler is marked `background`, so bullmq forks a child for each job.
 * This suite used to start `bun run worker` and wait for it.
 *
 * Every assertion is skipped when Redis is unreachable, because `bun run test` has
 * to pass on a machine with nothing running - the same contract the cache routes
 * keep.
 */
let app: HttpApp;
let base: string;
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
  // The first job forks a child, which builds its own container - slower than an
  // inline handler and worth waiting for before the first assertion.
  if (queueUp) await Bun.sleep(2500);
});

afterAll(async () => {
  // Stops the workers and the children with them; `onShutdown` ordering is the
  // container's, not this file's.
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
  // No subprocess to read stderr from any more: the handler runs in a child of
  // this process and its output is already in this process's stream.
  throw new Error(
    `job ${id} never produced a result. last=${JSON.stringify(last)}`,
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
