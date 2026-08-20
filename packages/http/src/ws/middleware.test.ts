import { describe, expect, it } from 'bun:test';
import { Logger, LogLevel, Module, provide, RequestContext } from '@dunx/core';
import { HttpFactory } from '../server/factory.js';
import { Gateway, OnClose, OnMessage, OnOpen } from './decorators.js';
import {
  SocketLoggingMiddleware,
  type SocketLoggingOptions,
} from './logging.js';
import {
  composeSocket,
  observe,
  type SocketContext,
  type SocketFrame,
  type SocketMiddleware,
  type SocketNext,
} from './middleware.js';
import type { Socket } from './socket.js';

interface Seen {
  readonly kind: string;
  readonly event: string | undefined;
  readonly gateway: string;
  readonly path: string;
  readonly data: unknown;
  readonly connectionId: string;
  readonly error: unknown;
  readonly value: unknown;
}

/** Records every dispatch it wraps, and leaves the outcome exactly as it found it. */
class Recorder implements SocketMiddleware {
  readonly seen: Seen[] = [];

  handle(frame: SocketFrame, ctx: SocketContext, next: SocketNext): unknown {
    return observe(next, (error, value) => {
      this.seen.push({
        kind: ctx.kind,
        event: ctx.event,
        gateway: ctx.gateway,
        path: ctx.path,
        data: frame.data,
        connectionId: frame.socket.data.id,
        error,
        value,
      });
    });
  }
}

@Gateway('/ws')
class Chat {
  @OnOpen()
  opened(socket: Socket): void {
    socket.send('ready');
  }

  @OnMessage('echo')
  echo(data: unknown): unknown {
    return data;
  }

  @OnMessage('boom')
  boom(): never {
    throw new Error('handler exploded');
  }

  @OnMessage('slow')
  async slow(data: unknown): Promise<unknown> {
    await Bun.sleep(1);
    return data;
  }

  @OnClose()
  closed(): undefined {
    return undefined;
  }
}

const recorder = new Recorder();

@Module({
  providers: [Chat, provide(Recorder, { useValue: recorder })],
  exports: [Recorder],
})
class ChatModule {}

interface Client {
  send(frame: string): void;
  next(ms?: number): Promise<string>;
  close(): void;
}

const connect = async (base: string): Promise<Client> => {
  const socket = new WebSocket(
    new URL('/ws', base).href.replace(/^http/, 'ws'),
  );
  const frames: string[] = [];
  const waiting: ((frame: string) => void)[] = [];
  socket.addEventListener('message', (event: MessageEvent) => {
    const frame = String(event.data);
    const waiter = waiting.shift();
    if (waiter) waiter(frame);
    else frames.push(frame);
  });
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => resolve(), { once: true });
    socket.addEventListener('error', () => reject(new Error('no connect')), {
      once: true,
    });
  });
  return {
    send: (frame) => socket.send(frame),
    next: (ms = 2000) =>
      new Promise<string>((resolve, reject) => {
        const queued = frames.shift();
        if (queued !== undefined) {
          resolve(queued);
          return;
        }
        const timer = setTimeout(() => reject(new Error('timed out')), ms);
        waiting.push((frame) => {
          clearTimeout(timer);
          resolve(frame);
        });
      }),
    close: () => socket.close(),
  };
};

describe('composeSocket', () => {
  const ctx: SocketContext = {
    gateway: 'G',
    path: '/ws',
    kind: 'message',
    event: 'x',
  };
  const frame = { socket: {} as Socket, data: 1 };

  it('runs the handler when there is no middleware', () => {
    expect(composeSocket([], ctx)(frame, () => 'handled')).toBe('handled');
  });

  it('runs outermost first and innermost last', () => {
    const order: string[] = [];
    const at = (name: string): SocketMiddleware => ({
      handle: (_frame, _ctx, next) => {
        order.push(`${name} in`);
        const result = next();
        order.push(`${name} out`);
        return result;
      },
    });
    composeSocket([at('a'), at('b')], ctx)(frame, () => {
      order.push('handler');
      return undefined;
    });
    expect(order).toEqual(['a in', 'b in', 'handler', 'b out', 'a out']);
  });

  it('lets a middleware answer the frame without the handler', () => {
    const refuse: SocketMiddleware = { handle: () => 'refused' };
    let ran = false;
    const result = composeSocket([refuse], ctx)(frame, () => {
      ran = true;
      return 'handled';
    });
    expect(result).toBe('refused');
    expect(ran).toBe(false);
  });
});

describe('observe', () => {
  it('reports a synchronous value and returns it untouched', () => {
    let seen: unknown;
    expect(
      observe(
        () => 7,
        (_error, value) => {
          seen = value;
        },
      ),
    ).toBe(7);
    expect(seen).toBe(7);
  });

  it('reports a synchronous throw and rethrows it', () => {
    let seen: unknown;
    expect(() =>
      observe(
        () => {
          throw new Error('nope');
        },
        (error) => {
          seen = error;
        },
      ),
    ).toThrow('nope');
    expect((seen as Error).message).toBe('nope');
  });

  it('reports a rejection and keeps it rejected', async () => {
    let seen: unknown;
    const result = observe(
      () => Promise.reject(new Error('later')),
      (error) => {
        seen = error;
      },
    );
    await expect(result as Promise<unknown>).rejects.toThrow('later');
    expect((seen as Error).message).toBe('later');
  });
});

describe('a gateway with socket middleware', () => {
  it('sees the whole lifecycle of a connection', async () => {
    recorder.seen.length = 0;
    const app = await HttpFactory.create(ChatModule, {
      socketMiddleware: [Recorder],
      socketLogging: false,
      bootLogging: false,
      requestLogging: false,
    });
    const base = await app.listen(0);
    const client = await connect(base);
    expect(await client.next()).toBe('ready');

    client.send(JSON.stringify({ event: 'echo', data: { hi: 1 } }));
    expect(JSON.parse(await client.next())).toEqual({
      event: 'echo',
      data: { hi: 1 },
    });

    client.send(JSON.stringify({ event: 'slow', data: 'wait' }));
    expect(JSON.parse(await client.next())).toEqual({
      event: 'slow',
      data: 'wait',
    });

    client.send(JSON.stringify({ event: 'boom' }));
    client.send(JSON.stringify({ event: 'nosuchthing', data: 2 }));
    await Bun.sleep(30);
    client.close();
    await Bun.sleep(30);
    await app.shutdown();

    const echo = recorder.seen.find((entry) => entry.event === 'echo');
    expect(echo?.gateway).toBe('Chat');
    expect(echo?.path).toBe('/ws');
    expect(echo?.data).toEqual({ hi: 1 });
    expect(echo?.value).toEqual({ hi: 1 });
    expect(echo?.error).toBeUndefined();
    expect(echo?.connectionId).toMatch(/^[0-9a-f-]{36}$/);

    // The awaited handler is reported on its own channel, with the value it
    // eventually answered rather than the promise it returned first.
    expect(recorder.seen.find((entry) => entry.event === 'slow')?.value).toBe(
      'wait',
    );

    const failed = recorder.seen.find((entry) => entry.event === 'boom');
    expect((failed?.error as Error | undefined)?.message).toBe(
      'handler exploded',
    );

    // An event no @OnMessage claims still reaches the chain, so a client's typo is
    // visible rather than silently dropped.
    expect(recorder.seen.some((entry) => entry.event === 'nosuchthing')).toBe(
      true,
    );

    expect(recorder.seen.map((entry) => entry.kind)).toContain('open');
    expect(recorder.seen.map((entry) => entry.kind)).toContain('close');
    // Every entry on one connection shares its id.
    expect(new Set(recorder.seen.map((entry) => entry.connectionId)).size).toBe(
      1,
    );
  });

  /**
   * `open` and `close` are wrapped even when the gateway declares neither, so a
   * connection is never invisible to an observer.
   */
  it('sees connect and disconnect on a gateway that declares neither', async () => {
    const seen: string[] = [];
    class Watch implements SocketMiddleware {
      handle(_frame: SocketFrame, ctx: SocketContext, next: SocketNext) {
        seen.push(ctx.kind);
        return next();
      }
    }

    @Gateway('/bare')
    class Bare {
      @OnMessage('ping')
      ping(): string {
        return 'pong';
      }
    }

    @Module({ providers: [Bare, Watch], exports: [Watch] })
    class BareModule {}

    const app = await HttpFactory.create(BareModule, {
      socketMiddleware: [Watch],
      socketLogging: false,
      bootLogging: false,
      requestLogging: false,
    });
    const base = await app.listen(0);
    const socket = new WebSocket(
      new URL('/bare', base).href.replace(/^http/, 'ws'),
    );
    await new Promise<void>((resolve) =>
      socket.addEventListener('open', () => resolve(), { once: true }),
    );
    socket.close();
    await Bun.sleep(40);
    await app.shutdown();

    expect(seen).toContain('open');
    expect(seen).toContain('close');
  });
});

class Captured extends Logger {
  readonly lines: { level: string; message: string; entry: unknown }[] = [];
  readonly logLevel = LogLevel.VERBOSE;

  #write(level: string) {
    return (message: unknown, ...rest: unknown[]): void => {
      this.lines.push({ level, message: String(message), entry: rest[0] });
    };
  }

  verbose = this.#write('verbose') as Logger['verbose'];
  debug = this.#write('debug') as Logger['debug'];
  info = this.#write('info') as Logger['info'];
  log = this.#write('info') as Logger['log'];
  warn = this.#write('warn') as Logger['warn'];
  error = this.#write('error') as Logger['error'];
  fatal = this.#write('fatal') as Logger['fatal'];
}

class Passthrough extends RequestContext {
  fields: Record<string, unknown> = {};
  getContext() {
    return this.fields;
  }
  updateContext(fields: Record<string, unknown>) {
    Object.assign(this.fields, fields);
  }
  runWithContext<T>(context: Record<string, unknown>, callback: () => T): T {
    this.fields = { ...context };
    return callback();
  }
}

const logged = (options: SocketLoggingOptions) => {
  const logger = new Captured();
  const middleware = new SocketLoggingMiddleware(
    logger,
    new Passthrough(),
    options,
  );
  return { logger, middleware };
};

const frameOf = (): SocketFrame => ({
  socket: { data: { id: 'conn-1', path: '/ws', context: null } } as Socket,
  data: { amount: 10 },
});

const ctxOf = (event: string | undefined, kind = 'message'): SocketContext => ({
  gateway: 'Chat',
  path: '/ws',
  kind: kind as SocketContext['kind'],
  event,
});

describe('SocketLoggingMiddleware', () => {
  it('writes at debug by default, and never at info', () => {
    const { logger, middleware } = logged({});
    middleware.handle(frameOf(), ctxOf('placeBet'), () => 'ack');
    expect(logger.lines).toHaveLength(1);
    expect(logger.lines[0]?.level).toBe('debug');
    expect(logger.lines[0]?.message).toBe('/ws placeBet');
    expect(logger.lines[0]?.entry).toMatchObject({
      gateway: 'Chat',
      path: '/ws',
      event: 'placeBet',
      connectionId: 'conn-1',
      replied: true,
    });
  });

  it('takes a level per event, and false skips one entirely', () => {
    const { logger, middleware } = logged({
      events: { placeBet: LogLevel.INFO, tick: false },
    });
    middleware.handle(frameOf(), ctxOf('placeBet'), () => undefined);
    middleware.handle(frameOf(), ctxOf('tick'), () => undefined);
    middleware.handle(frameOf(), ctxOf('other'), () => undefined);
    expect(logger.lines.map((line) => `${line.level}:${line.message}`)).toEqual(
      ['info:/ws placeBet', 'debug:/ws other'],
    );
  });

  it('names connect and disconnect, and lifecycle can be silenced on its own', () => {
    const { logger, middleware } = logged({});
    middleware.handle(frameOf(), ctxOf(undefined, 'open'), () => undefined);
    middleware.handle(frameOf(), ctxOf(undefined, 'close'), () => undefined);
    expect(logger.lines.map((line) => line.message)).toEqual([
      '/ws connect',
      '/ws disconnect',
    ]);

    const quiet = logged({ lifecycle: false });
    quiet.middleware.handle(frameOf(), ctxOf(undefined, 'open'), () => 1);
    expect(quiet.logger.lines).toHaveLength(0);
  });

  it('logs a throwing handler at error and rethrows it', () => {
    const { logger, middleware } = logged({});
    expect(() =>
      middleware.handle(frameOf(), ctxOf('boom'), () => {
        throw new Error('nope');
      }),
    ).toThrow('nope');
    expect(logger.lines[0]?.level).toBe('error');
    expect(logger.lines[0]?.entry).toMatchObject({ err: expect.any(Error) });
  });

  it('omits the payload unless asked, and caps it when it is', () => {
    const quiet = logged({});
    quiet.middleware.handle(frameOf(), ctxOf('bet'), () => undefined);
    expect(quiet.logger.lines[0]?.entry).not.toHaveProperty('payload');

    const loud = logged({ payload: true, maxPayloadLength: 4 });
    loud.middleware.handle(
      { socket: frameOf().socket, data: 'a much longer string' },
      ctxOf('bet'),
      () => undefined,
    );
    expect(loud.logger.lines[0]?.entry).toMatchObject({
      payload: '[20 chars]',
    });
  });

  it('puts the connection and the event in the async scope', () => {
    const logger = new Captured();
    const context = new Passthrough();
    const middleware = new SocketLoggingMiddleware(logger, context, {});
    middleware.handle(frameOf(), ctxOf('placeBet'), () => undefined);
    expect(context.getContext()).toMatchObject({
      connectionId: 'conn-1',
      event: 'placeBet',
      flow: 'ws',
      context: 'Chat',
    });
  });
});
