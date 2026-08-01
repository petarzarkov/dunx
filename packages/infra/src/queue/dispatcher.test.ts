import type { Job } from 'bullmq';
import { describe, expect, it } from 'bun:test';
import { JobDispatcher } from './dispatcher.js';
import type { DiscoveredJob, JobHandlerFn } from './discover.js';
import { QueueError, QueueErrorCode } from './errors.js';

// Dispatch reads three fields, so a literal stands in for a real bullmq Job.
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

const thrown = async (run: () => Promise<unknown>): Promise<QueueError> => {
  try {
    await run();
  } catch (error) {
    return error as QueueError;
  }
  throw new Error('expected a rejection');
};

describe('JobDispatcher', () => {
  it('routes each job name to its own handler', async () => {
    const dispatcher = new JobDispatcher([
      entry('emails', 'welcome', () => 'a'),
      entry('emails', 'digest', () => 'b'),
      entry('reports', 'nightly', () => 'c'),
    ]);

    expect(await dispatcher.dispatch(job('emails', 'digest'))).toBe('b');
    expect(await dispatcher.dispatch(job('reports', 'nightly'))).toBe('c');
    expect(dispatcher.queues).toEqual(['emails', 'reports']);
    expect(dispatcher.handlersFor('emails').map((one) => one.name)).toEqual([
      'welcome',
      'digest',
    ]);
  });

  it('passes the job through to the handler', async () => {
    const seen: string[] = [];
    const dispatcher = new JobDispatcher([
      entry('emails', 'welcome', (received) => seen.push(received.id ?? '')),
    ]);

    await dispatcher.dispatch(job('emails', 'welcome', '42'));
    expect(seen).toEqual(['42']);
  });

  it('rejects a job no handler claims, naming what it does serve', async () => {
    const dispatcher = new JobDispatcher([
      entry('emails', 'welcome', () => 'a'),
    ]);

    const error = await thrown(() =>
      dispatcher.dispatch(job('emails', 'unknown')),
    );

    expect(error).toBeInstanceOf(QueueError);
    expect(error.code).toBe(QueueErrorCode.UNKNOWN_JOB);
    expect(error.message).toContain('1 emails[unknown]');
    expect(error.message).toContain('welcome');
  });

  it('says the queue serves nothing when it has no handlers at all', async () => {
    const dispatcher = new JobDispatcher([
      entry('emails', 'welcome', () => 'a'),
    ]);

    const error = await thrown(() => dispatcher.dispatch(job('sms', 'ping')));
    expect(error.message).toContain('nothing');
  });

  it('lets a handler error through unchanged, so bullmq can retry it', async () => {
    const cause = new Error('smtp down');
    const dispatcher = new JobDispatcher([
      entry('emails', 'welcome', () => {
        throw cause;
      }),
    ]);

    expect(dispatcher.dispatch(job('emails', 'welcome'))).rejects.toBe(cause);
  });

  it('fails a handler that outruns jobTimeoutMs', async () => {
    const dispatcher = new JobDispatcher(
      [entry('emails', 'welcome', () => Bun.sleep(200))],
      20,
    );

    const error = await thrown(() =>
      dispatcher.dispatch(job('emails', 'welcome')),
    );

    expect(error.code).toBe(QueueErrorCode.TIMED_OUT);
    expect(error.message).toContain('Emails.welcome()');
    expect(error.message).toContain('20ms');
  });

  it('does not leave a pending timer behind when the handler finished', async () => {
    const dispatcher = new JobDispatcher(
      [entry('emails', 'welcome', async () => 'fast')],
      10_000,
    );

    // A timer that was not cleared would keep the loop alive for ten seconds, so
    // the assertion is that this call returns and the suite still ends.
    expect(await dispatcher.dispatch(job('emails', 'welcome'))).toBe('fast');
  });
});
