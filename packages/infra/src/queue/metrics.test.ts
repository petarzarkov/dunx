import { AppFactory } from '@dunx/core';
import type { Job } from 'bullmq';
import { describe, expect, it } from 'bun:test';
import { JobDispatcher } from './dispatcher.js';
import type { DiscoveredJob, JobHandlerFn } from './discover.js';
import { JobOutcome, QueueMetrics } from './metrics.js';
import { QueueModule } from './module.js';
import { JobPublisher } from './publisher.js';

const job = (queueName: string, name: string, id = '1'): Job =>
  ({ id, queueName, name }) as Job;

const entry = (
  queue: string,
  name: string,
  handler: JobHandlerFn,
): DiscoveredJob => ({
  queue,
  name,
  provider: 'Emails',
  method: name,
  handler,
});

/** Connection refused inside a millisecond, so a publish fails without waiting. */
const deadInit = {
  url: 'redis://127.0.0.1:1',
  connection: { connectionTimeout: 200, maxRetries: 0 },
} as const;

const statsFor = (
  metrics: QueueMetrics,
  queue: string,
  name: string,
): NonNullable<ReturnType<QueueMetrics['snapshot']>['jobs'][number]> => {
  const found = metrics
    .snapshot()
    .jobs.find((one) => one.queue === queue && one.name === name);
  if (!found) throw new Error(`no series for ${queue}/${name}`);
  return found;
};

describe('QueueMetrics', () => {
  it('keys one series per queue and job name', () => {
    const metrics = new QueueMetrics();
    metrics.observePublish('emails', 'welcome', 1_000);
    metrics.observePublish('emails', 'welcome', 3_000);
    metrics.observePublish('emails', 'digest', 2_000);
    metrics.observePublish('reports', 'welcome', 2_000);

    const report = metrics.snapshot();
    expect(report.published).toBe(4);
    expect(report.jobs).toHaveLength(3);
    expect(statsFor(metrics, 'emails', 'welcome').published).toBe(2);
    expect(statsFor(metrics, 'emails', 'welcome').publishDuration.max).toBe(
      3_000,
    );
    expect(statsFor(metrics, 'reports', 'welcome').published).toBe(1);
  });

  it('allocates a histogram per side, so a publisher holds no handler one', () => {
    const metrics = new QueueMetrics();
    metrics.observePublish('emails', 'welcome', 1_000);

    const stats = statsFor(metrics, 'emails', 'welcome');
    expect(stats.publishDuration.count).toBe(1);
    expect(stats.handlerDuration).toEqual({ count: 0 });
    expect(stats.handled).toBe(0);
  });

  it('separates a handler that threw from one the timeout rejected', () => {
    const metrics = new QueueMetrics();
    metrics.observeHandled('emails', 'welcome', 1_000, JobOutcome.COMPLETED);
    metrics.observeHandled('emails', 'welcome', 2_000, JobOutcome.FAILED);
    metrics.observeHandled('emails', 'welcome', 3_000, JobOutcome.TIMED_OUT);

    const stats = statsFor(metrics, 'emails', 'welcome');
    expect(stats.handled).toBe(3);
    expect(stats.failed).toBe(1);
    expect(stats.timedOut).toBe(1);
    expect(stats.handlerDuration.count).toBe(3);
    expect(metrics.snapshot().handled).toBe(3);
  });

  it('counts a failed enqueue in published as well as publishErrors', () => {
    const metrics = new QueueMetrics();
    metrics.observePublish('emails', 'welcome', 1_000, true);

    const stats = statsFor(metrics, 'emails', 'welcome');
    expect(stats.published).toBe(1);
    expect(stats.publishErrors).toBe(1);
  });

  it('collapses everything past the cap into one series', () => {
    const metrics = new QueueMetrics();
    for (let at = 0; at < 200; at += 1) {
      metrics.observePublish('emails', `name-${at}`, 1_000);
    }

    const report = metrics.snapshot();
    // 128 named series plus the one everything else lands in.
    expect(report.jobs).toHaveLength(129);
    expect(report.published).toBe(200);
    expect(statsFor(metrics, '(other)', '(other)').published).toBe(72);
  });

  it('drops every series and moves since forward on reset', () => {
    const metrics = new QueueMetrics();
    const before = metrics.snapshot().since;
    metrics.observePublish('emails', 'welcome', 1_000);
    metrics.observeHandled('emails', 'welcome', 1_000, JobOutcome.COMPLETED);
    metrics.reset();

    const after = metrics.snapshot();
    expect(after.jobs).toHaveLength(0);
    expect(after.published).toBe(0);
    expect(after.handled).toBe(0);
    expect(Date.parse(after.since)).toBeGreaterThanOrEqual(Date.parse(before));
  });
});

describe('the dispatch seam', () => {
  it('times a handler that returned', async () => {
    const metrics = new QueueMetrics();
    const dispatcher = new JobDispatcher(
      [entry('emails', 'welcome', () => 'sent')],
      undefined,
      metrics,
    );

    expect(await dispatcher.dispatch(job('emails', 'welcome'))).toBe('sent');
    const stats = statsFor(metrics, 'emails', 'welcome');
    expect(stats.handled).toBe(1);
    expect(stats.failed).toBe(0);
    expect(stats.handlerDuration.count).toBe(1);
  });

  it('records a handler that threw as failed', async () => {
    const metrics = new QueueMetrics();
    const dispatcher = new JobDispatcher(
      [
        entry('emails', 'welcome', () => {
          throw new Error('smtp down');
        }),
      ],
      undefined,
      metrics,
    );

    await expect(dispatcher.dispatch(job('emails', 'welcome'))).rejects.toThrow(
      'smtp down',
    );
    expect(statsFor(metrics, 'emails', 'welcome').failed).toBe(1);
    expect(statsFor(metrics, 'emails', 'welcome').timedOut).toBe(0);
  });

  it('records a jobTimeoutMs rejection as a timeout, not a failure', async () => {
    const metrics = new QueueMetrics();
    const dispatcher = new JobDispatcher(
      [entry('emails', 'welcome', () => Bun.sleep(200))],
      10,
      metrics,
    );

    await expect(
      dispatcher.dispatch(job('emails', 'welcome')),
    ).rejects.toThrow();
    const stats = statsFor(metrics, 'emails', 'welcome');
    expect(stats.timedOut).toBe(1);
    expect(stats.failed).toBe(0);
  });

  it('leaves an unclaimed job name unrecorded, since no handler ran', async () => {
    const metrics = new QueueMetrics();
    const dispatcher = new JobDispatcher(
      [entry('emails', 'welcome', () => 'sent')],
      undefined,
      metrics,
    );

    await expect(
      dispatcher.dispatch(job('emails', 'digest')),
    ).rejects.toThrow();
    expect(metrics.snapshot().jobs).toHaveLength(0);
  });

  it('dispatches unchanged with no metrics bound', async () => {
    const dispatcher = new JobDispatcher([
      entry('emails', 'welcome', () => 'sent'),
    ]);
    expect(await dispatcher.dispatch(job('emails', 'welcome'))).toBe('sent');
  });
});

describe('QueueModule wiring', () => {
  // Asserted on the module rather than through `app.get`: an unbound class
  // self-binds into whichever scope asks first, so resolving one proves nothing.
  it('binds nothing by default', () => {
    expect(QueueModule.forRoot(deadInit).exports).not.toContain(QueueMetrics);
    expect(QueueModule.forRoot(deadInit, { metrics: true }).exports).toContain(
      QueueMetrics,
    );
    expect(
      QueueModule.forRootAsync(() => deadInit, { metrics: true }).exports,
    ).toContain(QueueMetrics);
  });

  it('records a publish that could not reach the broker', async () => {
    const app = await AppFactory.create(
      QueueModule.forRoot(deadInit, { metrics: true }),
    );
    const metrics = app.get(QueueMetrics);

    await expect(
      app.get(JobPublisher).publish('emails', 'welcome', { to: 'ada' }),
    ).rejects.toThrow();

    const stats = statsFor(metrics, 'emails', 'welcome');
    expect(stats.published).toBe(1);
    expect(stats.publishErrors).toBe(1);
    expect(stats.publishDuration.count).toBe(1);
    await app.shutdown();
  });
});
