import { describe, expect, it } from 'bun:test';
import { Module } from '@dunx/core';
import { HttpFactory } from '../server/factory.js';
import { buildWebSocket } from './adapter.js';
import { Gateway, OnMessage } from './decorators.js';
import { discoverGateway, type DiscoveredGateway } from './discover.js';
import type {
  SocketContext,
  SocketFrame,
  SocketMiddleware,
  SocketNext,
} from './middleware.js';
import type { SocketErrorHandler } from './socket.js';

@Gateway('/ws')
class Chat {
  @OnMessage('boom')
  boom(): never {
    throw new Error('handler exploded');
  }
}

const discovered: readonly DiscoveredGateway[] = [discoverGateway(new Chat())];

/** An observer that watches every dispatch and does nothing with a failure. */
class Silent implements SocketMiddleware {
  handle(_frame: SocketFrame, _ctx: SocketContext, next: SocketNext): unknown {
    return next();
  }
}

class Reporter implements SocketMiddleware {
  readonly reportsErrors = true;

  handle(_frame: SocketFrame, _ctx: SocketContext, next: SocketNext): unknown {
    return next();
  }
}

@Module({ providers: [Chat, Silent] })
class ChatModule {}

const captured = async (run: () => Promise<void>): Promise<string[]> => {
  const lines: string[] = [];
  const { log, error } = console;
  const record = (...args: unknown[]): void => {
    lines.push(...args.map(String).join(' ').split('\n'));
  };
  console.log = record;
  console.error = record;
  try {
    await run();
  } finally {
    console.log = log;
    console.error = error;
  }
  return lines;
};

const messageOf = (line: string): unknown =>
  line.startsWith('{')
    ? (JSON.parse(line) as { message?: unknown }).message
    : undefined;

const warning = (lines: readonly string[]): unknown =>
  lines
    .map(messageOf)
    .find((message) => String(message).startsWith('Socket middleware is'));

type Options = Parameters<typeof HttpFactory.create>[1];

/** Boots, optionally serves, and gives back everything the process printed. */
const booted = async (
  options: Options,
  run: (url: string) => Promise<void> = async () => undefined,
): Promise<string[]> =>
  captured(async () => {
    const app = await HttpFactory.create(ChatModule, {
      bootLogging: false,
      ...options,
    });
    try {
      await run(await app.listen(0));
    } finally {
      await app.shutdown();
    }
  });

/** Sends one frame the gateway throws on, and waits for the throw to land. */
const provoke = async (url: string): Promise<void> => {
  const socket = new WebSocket(new URL('/ws', url).href.replace(/^http/, 'ws'));
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => resolve(), { once: true });
    socket.addEventListener('error', () => reject(new Error('no connect')), {
      once: true,
    });
  });
  socket.send(JSON.stringify({ event: 'boom' }));
  await Bun.sleep(20);
  socket.close();
};

const failures = (lines: readonly string[]): readonly string[] =>
  lines.filter((line) => line.includes('handler failed'));

/**
 * The fallback is dropped on the assumption that a middleware reports what it
 * saw, and nothing could check the assumption: an observer that ignores a throw
 * takes a wrong report down to no report at all, silently.
 */
describe('unreported socket errors', () => {
  it('warns when middleware exists and nothing says it reports', () => {
    const { warnings } = buildWebSocket(discovered, {}, [new Silent()]);

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('reportsErrors');
    expect(warnings[0]).toContain('Installed: Silent.');
  });

  it('is silent when a middleware declares that it reports', () => {
    const middleware = [new Silent(), new Reporter()];

    expect(buildWebSocket(discovered, {}, middleware).warnings).toEqual([]);
  });

  it('is silent when the app passed its own onError', () => {
    const onError: SocketErrorHandler = () => undefined;

    expect(
      buildWebSocket(discovered, { onError }, [new Silent()]).warnings,
    ).toEqual([]);
  });

  it('is silent with no middleware at all, where the fallback is installed', () => {
    expect(buildWebSocket(discovered, {}, []).warnings).toEqual([]);
  });

  it('reaches the logger at boot', async () => {
    const lines = await booted({
      socketLogging: false,
      socketMiddleware: [Silent],
    });

    expect(warning(lines)).toContain('Installed: Silent.');
  });

  /** The default chain reports, so the default app has nothing to be told. */
  it('does not fire for the socket logging middleware dunx installs', async () => {
    expect(warning(await booted({}))).toBeUndefined();
  });

  /**
   * The warning is the whole change. Which handler answers a failure is not: an
   * app that does report would start seeing every one of them twice.
   */
  it('changes nothing about where a failure goes', async () => {
    const silenced = await booted(
      { socketLogging: false, socketMiddleware: [Silent] },
      provoke,
    );
    expect(failures(silenced)).toEqual([]);

    const fallback = await booted({ socketLogging: false }, provoke);
    expect(failures(fallback)).toHaveLength(1);
    expect(warning(fallback)).toBeUndefined();
  });
});
