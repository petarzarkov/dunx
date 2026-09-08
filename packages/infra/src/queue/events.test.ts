import { AsyncRequestContext, ConsoleLogger, LogLevel } from '@dunx/core';
import { describe, expect, it } from 'bun:test';
import { JobEvents } from './events.js';
import { QueueConnection } from './connection.js';
import { QueueOptions } from './options.js';

/**
 * Offline, the way `connection.test.ts` runs: a port nothing answers on, one
 * attempt, no reconnect. Everything asserted here is about what is opened and
 * what is closed, which does not need a broker - and `QueueEvents` starts a
 * blocking read in its constructor, so the timeouts keep that bounded.
 */
const options = (): QueueOptions =>
  new QueueOptions({
    url: 'redis://127.0.0.1:1',
    prefix: 'dunx-test',
    connection: {
      connectionTimeout: 50,
      maxRetries: 0,
      autoReconnect: false,
    },
  });

const build = (): { events: JobEvents; connection: QueueConnection } => {
  // `error` and above, so an unreachable broker does not print a wall of
  // warnings for the failure every test here is arranging on purpose.
  const logger = new ConsoleLogger(new AsyncRequestContext(), LogLevel.ERROR);
  const connection = new QueueConnection(options(), logger);
  return { events: new JobEvents(connection, options(), logger), connection };
};

describe('JobEvents', () => {
  it('opens nothing until something asks for a stream', () => {
    const { events, connection } = build();

    // `autorun` starts a blocking XREAD in the constructor, so an app that
    // publishes and never waits must not be holding one of these.
    expect(events.opened).toEqual([]);
    expect(connection.open).toBe(0);
  });

  it('memoises per queue, so two waiters share one blocking socket', async () => {
    const { events, connection } = build();

    const first = events.events('thumbnails');
    const second = events.events('thumbnails');

    expect(second).toBe(first);
    expect(events.opened).toEqual(['thumbnails']);

    await events.onShutdown();
    connection.onShutdown();
  });

  it('passes the prefix through, so it reads the keys the publisher writes', async () => {
    const { events, connection } = build();

    // A stream under a different prefix is a stream that never fires: bullmq
    // namespaces the event keys the same way it namespaces the job keys.
    const opened = events.events('thumbnails') as unknown as {
      opts: { prefix?: string };
    };
    expect(opened.opts.prefix).toBe('dunx-test');

    await events.onShutdown();
    connection.onShutdown();
  });

  it('forgets every stream on shutdown', async () => {
    const { events, connection } = build();

    events.events('one');
    events.events('two');
    expect(events.opened).toEqual(['one', 'two']);

    await events.onShutdown();

    expect(events.opened).toEqual([]);
    connection.onShutdown();
  });
});
