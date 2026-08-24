import { Logger, Module, provide, type App } from '@dunx/core';
import type { Job } from 'bullmq';
import { afterEach, describe, expect, it } from 'bun:test';
import { Quiet } from '../quiet.fixture.js';
import { JobHandler } from './decorators.js';
import { QueueErrorCode } from './errors.js';
import { QueueModule } from './module.js';
import { JobProcessor } from './processor.js';

/**
 * The child half of a sandboxed worker, driven directly. bullmq calls the default
 * export of a file with a `Job`, so a literal with the four fields it reads stands
 * in for one, the same way `dispatcher.test.ts` does: no broker, no fork.
 *
 * What is worth asserting here is what only the child does. The dispatch itself is
 * `dispatcher.test.ts`, and the discovery is `discover.test.ts`.
 */
const url = 'valkey://localhost:6379';

interface Logged {
  readonly job: string[];
  readonly errors: string[];
}

const logged: Logged = { job: [], errors: [] };

const job = (name: string, id = '1'): Job =>
  ({
    id,
    queueName: 'emails',
    name,
    log: (line: string) => {
      logged.job.push(line);
      return Promise.resolve(1);
    },
  }) as unknown as Job;

class Emails {
  static seen: string[] = [];

  @JobHandler({ queue: 'emails', name: 'welcome' })
  welcome(): string {
    Emails.seen.push('welcome');
    return 'sent';
  }

  @JobHandler({ queue: 'emails', name: 'boom' })
  boom(): never {
    throw new Error('handler exploded');
  }
}

const logger = new Quiet();

@Module({
  imports: [QueueModule.forRoot({ url })],
  providers: [Emails, provide(Logger, { useValue: logger })],
  exports: [Logger],
  global: true,
})
class Root {}

/**
 * `#boot` registers a SIGTERM listener per container and sets `DUNX_JOB_WORKER`, so
 * a suite that boots several would leak both into every later test file.
 */
const before = process.listenerCount('SIGTERM');

afterEach(() => {
  logged.job.length = 0;
  logged.errors.length = 0;
  Emails.seen.length = 0;
  logger.errors.length = 0;
  delete process.env['DUNX_JOB_WORKER'];
  const extra = process.listenerCount('SIGTERM') - before;
  for (let i = 0; i < extra; i += 1) {
    const listeners = process.listeners('SIGTERM');
    const last = listeners[listeners.length - 1];
    if (last) process.removeListener('SIGTERM', last);
  }
});

describe('JobProcessor.handle', () => {
  it('boots the container on the first job and returns the handler result', async () => {
    const processor = new JobProcessor(Root);

    expect(await processor.handle(job('welcome'))).toBe('sent');
    expect(Emails.seen).toEqual(['welcome']);
  });

  /** Built once per child, not per job: a container per job would be the cost the
   * sandbox exists to amortise. */
  it('reuses the container across jobs', async () => {
    const processor = new JobProcessor(Root);

    await processor.handle(job('welcome'));
    const after = process.listenerCount('SIGTERM');
    await processor.handle(job('welcome', '2'));

    expect(Emails.seen).toEqual(['welcome', 'welcome']);
    // A second boot would register a second SIGTERM listener.
    expect(process.listenerCount('SIGTERM')).toBe(after);
  });

  /** Set before the container is built, so a provider can read it in its own
   * constructor. */
  it('marks the process as a job worker', async () => {
    expect(process.env['DUNX_JOB_WORKER']).toBeUndefined();
    await new JobProcessor(Root).handle(job('welcome'));

    expect(process.env['DUNX_JOB_WORKER']).toBe('true');
  });

  it('writes start and completion to the job log', async () => {
    await new JobProcessor(Root).handle(job('welcome'));

    expect(logged.job[0]).toBe(
      `started 1 emails[welcome] in pid ${process.pid}`,
    );
    expect(logged.job[1]).toBe('completed 1 emails[welcome]');
  });

  it('writes nothing to the job log when trace is off', async () => {
    await new JobProcessor(Root, { trace: false }).handle(job('welcome'));

    expect(logged.job).toEqual([]);
  });

  describe('a failing handler', () => {
    const failing = (): Promise<unknown> =>
      new JobProcessor(Root).handle(job('boom'));

    /** Rethrown always: bullmq owns the retry, the backoff and the attempt count,
     * and swallowing it would mark a job completed that did nothing. */
    it('rethrows so bullmq can retry it', async () => {
      expect(failing()).rejects.toThrow('handler exploded');
    });

    it('reports it through the bound Logger and the job log both', async () => {
      await failing().catch(() => undefined);

      expect(logger.errors[0]).toBe('Job failed 1 emails[boom]');
      const failure = logged.job.find((line) => line.startsWith('failed'));
      expect(failure).toContain('failed 1 emails[boom]: handler exploded');
      // The stack too, which is what makes bull-board's log tab worth opening.
      expect(failure).toContain('processor.test.ts');
    });

    it('keeps the job log clean when trace is off', async () => {
      await new JobProcessor(Root, { trace: false })
        .handle(job('boom'))
        .catch(() => undefined);

      expect(logged.job).toEqual([]);
      expect(logger.errors).toHaveLength(1);
    });
  });

  /**
   * The same selection the parent makes, so the two fail identically on the same
   * wiring rather than diverging until a job arrives. The filter selecting nothing
   * is a boot error, not a dispatch error: a child with no handler would idle.
   */
  describe('the queue filter', () => {
    it('serves a real subset', async () => {
      const processor = new JobProcessor(Root, { queues: ['emails'] });

      expect(await processor.handle(job('welcome'))).toBe('sent');
    });

    it('is a boot error when it selects nothing', async () => {
      const error = await new JobProcessor(Root, { queues: ['reports'] })
        .handle(job('welcome'))
        .then(
          () => undefined,
          (reason: unknown) => reason,
        );

      expect(error).toMatchObject({ code: QueueErrorCode.NO_HANDLERS });
      expect(String(error)).toContain('No handler consumes reports');
      expect(String(error)).toContain('would idle forever');
    });

    /** A typo in one name of several would otherwise start a child that quietly
     * served only the queues that were spelled right. */
    it('names the queue that matched nothing when the others did', async () => {
      const error = await new JobProcessor(Root, {
        queues: ['emails', 'repots'],
      })
        .handle(job('welcome'))
        .then(
          () => undefined,
          (reason: unknown) => reason,
        );

      expect(error).toMatchObject({ code: QueueErrorCode.NO_HANDLERS });
      expect(String(error)).toContain('No handler consumes repots');
      expect(String(error)).toContain('Found handlers for emails');
    });
  });

  it('runs onShutdown before the container tears down', async () => {
    const order: string[] = [];
    let seen: App | undefined;

    class Closes {
      onShutdown(): void {
        order.push('container');
      }
    }

    @Module({
      imports: [QueueModule.forRoot({ url })],
      providers: [Emails, Closes, provide(Logger, { useValue: logger })],
      exports: [Logger],
      global: true,
    })
    class WithTeardown {}

    const processor = new JobProcessor(WithTeardown, {
      onShutdown: (app) => {
        seen = app;
        order.push('onShutdown');
      },
    });
    await processor.handle(job('welcome'));

    process.emit('SIGTERM');
    // The listener starts an async chain, so let it settle.
    await Bun.sleep(20);

    expect(order).toEqual(['onShutdown', 'container']);
    expect(seen?.get(Emails)).toBeInstanceOf(Emails);
  });
});
