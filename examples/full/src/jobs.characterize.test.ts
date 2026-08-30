import { afterAll, beforeAll, expect, it } from 'bun:test';
import type { HttpApp } from '@dunx/http';
import { createApp } from './main.js';

/**
 * **The behaviour a second queue backend has to reproduce**, asserted through the
 * HTTP routes alone. Nothing here imports a bullmq type, so the same file runs
 * unchanged once `QueueModule` can be pointed at SQLite or Postgres. The plan in
 * `internal/notes/roadmap/db-backed-queues-and-cache.md` builds against it.
 *
 * The `tasks` queue is in-process; `thumbnails` is forked and covered by
 * `jobs.test.ts`. A queue is sandboxed when any handler on it asks to be, so the
 * two paths cannot share a queue.
 *
 * Skipped whole when the broker is unreachable, the contract every other
 * service-dependent suite here keeps.
 */
let app: HttpApp;
let base: string;
let queueUp = false;

const api = (path: string): URL => new URL(`api/${path}`, base);

interface TaskView {
  readonly id: string;
  readonly state: string;
  readonly result: unknown;
  readonly failedReason: string | null;
  readonly attemptsMade: number;
}

interface TaskInit {
  readonly name: 'echo' | 'flaky';
  readonly note?: string;
  readonly token?: string;
  readonly failTimes?: number;
  readonly delayMs?: number;
  readonly attempts?: number;
}

const enqueue = async (body: TaskInit): Promise<string> => {
  const response = await fetch(api('jobs/tasks'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as { id: string }).id;
};

const view = async (id: string): Promise<TaskView> =>
  (await (await fetch(api(`jobs/tasks/${id}`))).json()) as TaskView;

/**
 * Waits for the **result**, not merely a terminal state. A backend can report
 * `completed` before the return value is readable, so stopping at the state
 * flakes on exactly the assertion that matters. A failure has no result, so
 * `failed` ends the wait on its own.
 *
 * Polled rather than slept, so a slow machine waits instead of failing.
 */
const settled = async (id: string, ms = 15_000): Promise<TaskView> => {
  const deadline = Date.now() + ms;
  let last: TaskView | undefined;
  while (Date.now() < deadline) {
    last = await view(id);
    if (last.result !== null || last.state === 'failed') return last;
    await Bun.sleep(50);
  }
  throw new Error(`job ${id} never settled. last=${JSON.stringify(last)}`);
};

beforeAll(async () => {
  app = await createApp();
  base = await app.listen(0);
  const probe = await fetch(api('jobs/tasks'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'echo', note: 'probe' }),
  });
  queueUp = probe.status === 201;
});

afterAll(async () => {
  await app.shutdown();
});

const whenUp = it.if(process.env['SKIP_QUEUE_TESTS'] !== '1');

whenUp(
  'runs a job in this process and reports the handler result',
  async () => {
    if (!queueUp) return;
    const finished = await settled(await enqueue({ name: 'echo', note: 'hi' }));
    expect(finished.state).toBe('completed');
    expect(finished.result).toMatchObject({ note: 'hi' });
  },
  20_000,
);

whenUp(
  'retries a throwing handler and completes once it stops throwing',
  async () => {
    if (!queueUp) return;
    const token = `retry-${Bun.randomUUIDv7()}`;
    const finished = await settled(
      await enqueue({ name: 'flaky', token, failTimes: 1, attempts: 3 }),
    );
    expect(finished.state).toBe('completed');
    // The second attempt succeeded, so the first ran and was retried.
    expect(finished.result).toMatchObject({ attempts: 2 });
  },
  20_000,
);

/**
 * `failed` is observable **between** attempts, not only after the last one, so a
 * read that stops at the first `failed` can see a job that is about to be retried.
 * The wait is for the attempt budget to be spent as well.
 */
const exhausted = async (
  id: string,
  attempts: number,
  ms = 15_000,
): Promise<TaskView> => {
  const deadline = Date.now() + ms;
  let last: TaskView | undefined;
  while (Date.now() < deadline) {
    last = await view(id);
    if (last.state === 'failed' && last.attemptsMade >= attempts) return last;
    await Bun.sleep(50);
  }
  throw new Error(`job ${id} never exhausted. last=${JSON.stringify(last)}`);
};

whenUp(
  'stops at the attempt limit and reports why it failed',
  async () => {
    if (!queueUp) return;
    const token = `fail-${Bun.randomUUIDv7()}`;
    const id = await enqueue({
      name: 'flaky',
      token,
      failTimes: 5,
      attempts: 2,
    });
    const finished = await exhausted(id, 2);
    expect(finished.state).toBe('failed');
    expect(finished.failedReason).toContain('on purpose');
    expect(finished.attemptsMade).toBe(2);
  },
  20_000,
);

whenUp(
  'holds a delayed job back, then runs it',
  async () => {
    if (!queueUp) return;
    const id = await enqueue({ name: 'echo', note: 'later', delayMs: 700 });
    // Observable immediately: queued, and not yet a candidate.
    expect((await view(id)).state).toBe('delayed');
    const finished = await settled(id);
    expect(finished.state).toBe('completed');
    expect(finished.result).toMatchObject({ note: 'later' });
  },
  20_000,
);

whenUp(
  'drains a batch enqueued at once',
  async () => {
    if (!queueUp) return;
    const ids = await Promise.all(
      Array.from({ length: 5 }, (_, n) =>
        enqueue({ name: 'echo', note: `batch-${n}` }),
      ),
    );
    const states = await Promise.all(ids.map((id) => settled(id)));
    expect(states.map((s) => s.state)).toEqual(Array(5).fill('completed'));
  },
  30_000,
);

whenUp(
  'reports the queues the publisher has opened',
  async () => {
    if (!queueUp) return;
    const body = (await (await fetch(api('jobs/queues'))).json()) as {
      opened: string[];
    };
    expect(body.opened).toContain('tasks');
  },
  15_000,
);

whenUp(
  'answers 404 for a task id nobody enqueued',
  async () => {
    if (!queueUp) return;
    expect((await fetch(api('jobs/tasks/999999'))).status).toBe(404);
  },
  15_000,
);

it('degrades to 503 rather than hanging when the broker is unreachable', async () => {
  if (queueUp) return;
  const response = await fetch(api('jobs/tasks'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'echo' }),
  });
  expect(response.status).toBe(503);
});
