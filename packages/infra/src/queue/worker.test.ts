import {
  AppFactory,
  inject,
  Module,
  type Ctor,
  type ModuleRef,
} from '@dunx/core';
import type { Job } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { defaultRedisUrl } from '../redis/options.js';
import { QueueConnection } from './connection.js';
import { JobHandler } from './decorators.js';
import { QueueError, QueueErrorCode } from './errors.js';
import { QueueModule } from './module.js';
import { JobPublisher } from './publisher.js';
import { WorkerFactory, type WorkerApp } from './worker.js';

const url = defaultRedisUrl();

/**
 * The same probe `@dunx/infra/redis`'s suite uses: CI has no Redis, so everything
 * that needs one is conditional. Retries off, otherwise an unreachable host sits
 * in the offline queue for the default ten seconds.
 */
const reachable = async (): Promise<boolean> => {
  const client = new Bun.RedisClient(url, {
    connectionTimeout: 500,
    autoReconnect: false,
    enableOfflineQueue: false,
    maxRetries: 0,
  });
  try {
    await client.connect();
    await client.ping();
    return true;
  } catch {
    return false;
  } finally {
    client.close();
  }
};

const live = await reachable();
if (!live) {
  console.log(`[dunx] queue integration tests skipped — ${url} unreachable`);
}

// A fresh namespace per run, so a leftover job can never make a test pass.
const ns = `dunx-test-${Bun.randomUUIDv7()}`;
const EMAILS = `${ns}-emails`;
const REPORTS = `${ns}-reports`;
const SLOW = `${ns}-slow`;
const HUNG = `${ns}-hung`;

/**
 * Injected into the handlers with `inject()` in a field initialiser, which needs no
 * compiler transform — and doubles as the witness that container teardown runs
 * after the workers have drained.
 */
class Recorder {
  readonly events: string[] = [];

  onShutdown(): void {
    this.events.push('container:shutdown');
  }
}

class Emails {
  readonly recorder = inject(Recorder);

  @JobHandler({ queue: EMAILS, name: 'welcome' })
  async welcome(job: Job<{ to: string }>): Promise<{ sent: string }> {
    this.recorder.events.push(`welcome:${job.data.to}`);
    return { sent: job.data.to };
  }

  @JobHandler({ queue: EMAILS, name: 'boom' })
  async boom(): Promise<never> {
    throw new Error('handler exploded');
  }
}

class Reports {
  readonly recorder = inject(Recorder);

  @JobHandler({ queue: REPORTS, name: 'nightly' })
  async nightly(): Promise<string> {
    this.recorder.events.push('nightly');
    return 'nightly';
  }
}

class Slow {
  readonly recorder = inject(Recorder);

  @JobHandler({ queue: SLOW, name: 'drain-me' })
  async drainMe(): Promise<void> {
    this.recorder.events.push('slow:started');
    await Bun.sleep(150);
    this.recorder.events.push('slow:finished');
  }
}

class Hung {
  @JobHandler({ queue: HUNG, name: 'never-returns' })
  async neverReturns(): Promise<void> {
    await Bun.sleep(2000);
  }
}

// Undecorated on purpose: a DynamicModule merges what its class declares with what
// it carries, so a @Module here would import QueueModule twice over.
class Root {}

const moduleWith = (
  providers: readonly Ctor<unknown>[],
  timeoutMs?: number,
): ModuleRef => ({
  module: Root,
  imports: [
    QueueModule.forRoot({
      url,
      prefix: ns,
      ...(timeoutMs !== undefined && { jobTimeoutMs: timeoutMs }),
    }),
  ],
  providers,
});

const until = async (
  condition: () => boolean | Promise<boolean>,
  what: string,
  timeoutMs = 5000,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await Bun.sleep(10);
  }
  throw new Error(`timed out waiting for ${what}`);
};

describe('WorkerFactory.create rejects a worker that could not work', () => {
  it('names QueueModule when the module graph has no queue bindings', async () => {
    // Not caught by resolving QueueOptions: it is a class the container would
    // self-bind, so the app would silently get default options.
    @Module({ providers: [Reports] })
    class NoQueue {}

    const error = await WorkerFactory.create(NoQueue).catch(
      (thrown: QueueError) => thrown,
    );

    expect((error as QueueError).code).toBe(QueueErrorCode.INVALID_STATE);
    expect((error as QueueError).message).toContain('QueueModule.forRoot()');
  });

  it('refuses to start with no handlers at all', async () => {
    const error = await WorkerFactory.create(moduleWith([])).catch(
      (thrown: QueueError) => thrown,
    );

    expect(error).toBeInstanceOf(QueueError);
    expect((error as QueueError).code).toBe(QueueErrorCode.NO_HANDLERS);
    expect((error as QueueError).message).toContain('@JobHandler');
  });

  it('refuses a queues filter that matches nothing', async () => {
    const error = await WorkerFactory.create(moduleWith([Emails, Reports]), {
      queues: ['typo'],
    }).catch((thrown: QueueError) => thrown);

    expect((error as QueueError).code).toBe(QueueErrorCode.NO_HANDLERS);
  });

  it('reports the queue that was misspelled among several', async () => {
    const error = await WorkerFactory.create(moduleWith([Emails, Reports]), {
      queues: [EMAILS, 'reprots'],
    }).catch((thrown: QueueError) => thrown);

    expect((error as QueueError).message).toContain('reprots');
    expect((error as QueueError).message).toContain(EMAILS);
  });

  it('discovers without opening a connection, so a filter can be inspected', async () => {
    const worker = await WorkerFactory.create(moduleWith([Emails, Reports]), {
      queues: [REPORTS],
    });

    expect(worker.queues).toEqual([REPORTS]);
    expect(worker.jobs.map((job) => job.name)).toEqual(['nightly']);
    expect(worker.get(QueueConnection).open).toBe(0);
    await worker.shutdown();
  });

  it('hooks each signal once, however often it is asked', async () => {
    const worker = await WorkerFactory.create(moduleWith([Reports]));
    const before = process.listenerCount('SIGHUP');
    try {
      expect(worker.enableShutdownHooks(['SIGHUP'])).toBe(worker);
      worker.enableShutdownHooks(['SIGHUP']);
      expect(process.listenerCount('SIGHUP')).toBe(before + 1);
    } finally {
      process.removeAllListeners('SIGHUP');
      await worker.shutdown();
    }
  });
});

describe.if(live)('a worker against a live server', () => {
  let worker: WorkerApp;
  let publisher: JobPublisher;
  let recorder: Recorder;

  beforeAll(async () => {
    worker = await WorkerFactory.create(moduleWith([Emails, Reports]));
    await worker.start();
    publisher = worker.get(JobPublisher);
    recorder = worker.get(Recorder);
  });

  afterAll(async () => {
    await publisher.queue(EMAILS).obliterate({ force: true });
    await publisher.queue(REPORTS).obliterate({ force: true });
    await worker.shutdown();
  });

  it('consumes a published job and stores what the handler returned', async () => {
    const job = await publisher.publish(EMAILS, 'welcome', { to: 'ada' });

    await until(
      () => recorder.events.includes('welcome:ada'),
      'the welcome handler',
    );

    const stored = await publisher.queue(EMAILS).getJob(job.id!);
    expect(stored?.returnvalue).toEqual({ sent: 'ada' });
    expect(await stored?.getState()).toBe('completed');
  });

  it('serves every discovered queue, not just the first', async () => {
    await publisher.publish(REPORTS, 'nightly', {});
    await until(
      () => recorder.events.includes('nightly'),
      'the report handler',
    );

    expect([...worker.queues].sort()).toEqual([EMAILS, REPORTS].sort());
  });

  it('fails a job whose handler throws, keeping the reason', async () => {
    const job = await publisher.publish(EMAILS, 'boom', {});

    await until(async () => {
      const stored = await publisher.queue(EMAILS).getJob(job.id!);
      return (await stored?.getState()) === 'failed';
    }, 'the boom job to fail');

    const stored = await publisher.queue(EMAILS).getJob(job.id!);
    expect(stored?.failedReason).toContain('handler exploded');
  });

  it('fails a job no handler claims, and says what it does serve', async () => {
    const job = await publisher.publish(EMAILS, 'not-a-handler', {});

    await until(async () => {
      const stored = await publisher.queue(EMAILS).getJob(job.id!);
      return (await stored?.getState()) === 'failed';
    }, 'the unclaimed job to fail');

    const stored = await publisher.queue(EMAILS).getJob(job.id!);
    expect(stored?.failedReason).toContain('No handler for');
    expect(stored?.failedReason).toContain('welcome');
  });

  it('opens one socket per bullmq object and reports them', () => {
    // Two workers plus the two queues the tests published through.
    expect(worker.get(QueueConnection).open).toBeGreaterThanOrEqual(2);
  });

  it('rejects a second start()', async () => {
    expect(worker.start()).rejects.toThrow(/already run/);
  });
});

describe.if(live)('shutdown', () => {
  it('drains an in-flight job before the container tears down', async () => {
    const worker = await WorkerFactory.create(moduleWith([Slow]));
    await worker.start();
    const publisher = worker.get(JobPublisher);
    const recorder = worker.get(Recorder);

    await publisher.publish(SLOW, 'drain-me', {});
    await until(
      () => recorder.events.includes('slow:started'),
      'the slow handler to start',
    );

    await worker.shutdown();

    // Not just "the handler finished" — it finished *before* the providers it
    // depends on were torn down, which is what reverse-order shutdown buys.
    expect(recorder.events).toEqual([
      'slow:started',
      'slow:finished',
      'container:shutdown',
    ]);
    expect(worker.get(QueueConnection).open).toBe(0);

    const cleanup = await AppFactory.create(moduleWith([Slow]));
    await cleanup.get(JobPublisher).queue(SLOW).obliterate({ force: true });
    await cleanup.shutdown();
  });

  it('resolves closed once, however often shutdown is called', async () => {
    const worker = await WorkerFactory.create(moduleWith([Reports]));
    await Promise.all([worker.shutdown(), worker.shutdown()]);
    expect(worker.closed).resolves.toBeUndefined();
  });
});

describe.if(live)('jobTimeoutMs', () => {
  it('fails a handler that hangs, so the lock is released', async () => {
    const worker = await WorkerFactory.create(moduleWith([Hung], 40));
    await worker.start();
    const publisher = worker.get(JobPublisher);
    const job = await publisher.publish(HUNG, 'never-returns', {});

    await until(async () => {
      const stored = await publisher.queue(HUNG).getJob(job.id!);
      return (await stored?.getState()) === 'failed';
    }, 'the hung job to fail');

    const stored = await publisher.queue(HUNG).getJob(job.id!);
    expect(stored?.failedReason).toContain('jobTimeoutMs');

    await publisher.queue(HUNG).obliterate({ force: true });
    await worker.shutdown();
  });
});
