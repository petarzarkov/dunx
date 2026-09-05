import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { inject, Logger, LogLevel, Module, provide } from '@dunx/core';
import {
  Controller,
  Gateway,
  Get,
  HttpError,
  HttpOptionsProvider,
  OnMessage,
  Post,
  UseGuards,
  type ErrorHandler,
  type Middleware,
  type RouteInput,
} from '@dunx/http';
import { RecordingLogger } from './logger.js';
import { createTestServer, type TestServer } from './server.js';

abstract class Greeter {
  abstract greet(): string;
}

class RealGreeter extends Greeter {
  greet(): string {
    return 'hello from production';
  }
}

class FakeGreeter extends Greeter {
  greet(): string {
    return 'hello from the fixture';
  }
}

@Controller('echo')
class EchoController {
  readonly greeter = inject(Greeter);

  @Get('/')
  hello(): { greeting: string } {
    return { greeting: this.greeter.greet() };
  }

  @Post('/')
  async received(
    input: RouteInput,
  ): Promise<{ body: unknown; type: string | null }> {
    return {
      body: await input.req.json(),
      type: input.req.headers.get('content-type'),
    };
  }

  @Get('/page')
  page(): Response {
    return new Response('<h1>hi</h1>', {
      headers: { 'content-type': 'text/html' },
    });
  }

  @Get('/nothing')
  nothing(): undefined {
    return undefined;
  }
}

@Module({
  controllers: [EchoController],
  providers: [provide(Greeter, { useClass: RealGreeter })],
})
class EchoModule {}

/**
 * Bun's types declare `expect().rejects.toThrow()` as returning `void`, which
 * oxlint's `await-thenable` reads as an awaited non-promise. The rejection is read
 * directly instead, as core's own suites do.
 */
const rejectionMessage = async (promise: Promise<unknown>): Promise<string> => {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  if (!(error instanceof Error))
    throw new Error('expected the promise to reject with an Error');
  return error.message;
};

let server: TestServer;

beforeAll(async () => {
  server = await createTestServer({ modules: [EchoModule] });
});

afterAll(async () => {
  await server.close();
});

describe('createTestServer()', () => {
  it('binds a real server on an ephemeral port', async () => {
    const url = new URL(server.url);

    expect(url.protocol).toBe('http:');
    expect(Number(url.port)).toBeGreaterThan(0);
    // Port 0, so a `bun start` already holding 3000 cannot collide with a suite.
    expect(url.port).not.toBe('3000');
    // The real Bun.serve is what answered, not a fake dispatcher.
    expect(server.app.gatewayPaths).toEqual([]);
  });

  it('returns status and parsed body together', async () => {
    const { status, headers, body } = await server.json<{ greeting: string }>(
      'echo',
    );

    expect(status).toBe(200);
    expect(headers.get('content-type')).toContain('application/json');
    expect(body.greeting).toBe('hello from production');
  });

  it('sends a JSON body for any verb, with the header set', async () => {
    const { status, body } = await server.json<{
      body: unknown;
      type: string;
    }>('echo', { method: 'POST', json: { id: 7 } });

    expect(status).toBe(201);
    expect(body.body).toEqual({ id: 7 });
    expect(body.type).toBe('application/json');
  });

  it('leaves an explicit content-type alone', async () => {
    const { body } = await server.json<{ type: string }>('echo', {
      method: 'POST',
      json: { id: 7 },
      headers: { 'content-type': 'application/vnd.api+json' },
    });

    expect(body.type).toBe('application/vnd.api+json');
  });

  it('hands back the raw Response when the body is not JSON', async () => {
    const response = await server.request('echo/page');

    expect(response.headers.get('content-type')).toContain('text/html');
    expect(await response.text()).toBe('<h1>hi</h1>');
  });

  it('explains itself when json() meets a response that is not JSON', async () => {
    expect(await rejectionMessage(server.json('echo/nothing'))).toContain(
      'GET /echo/nothing answered 204 with an empty body',
    );
    expect(await rejectionMessage(server.json('echo/page'))).toContain(
      'answered 200 with a text/html body',
    );
  });
});

describe('createTestServer() options', () => {
  it('replaces a provider the controllers depend on', async () => {
    const fixture = await createTestServer({
      modules: [EchoModule],
      overrides: [provide(Greeter, { useClass: FakeGreeter })],
    });

    try {
      const { body } = await fixture.json<{ greeting: string }>('echo');
      expect(body.greeting).toBe('hello from the fixture');
    } finally {
      await fixture.close();
    }
  });

  it('applies a global prefix before listening', async () => {
    const fixture = await createTestServer({
      modules: EchoModule,
      prefix: 'api',
    });

    try {
      expect((await fixture.json('api/echo')).status).toBe(200);
      expect((await fixture.request('echo')).status).toBe(404);
    } finally {
      await fixture.close();
    }
  });

  it('keeps request logging off unless asked, and honours it when asked', async () => {
    const quiet = new RecordingLogger();
    const loud = new RecordingLogger();

    const silent = await createTestServer({
      modules: [EchoModule],
      overrides: [provide(Logger, { useValue: quiet })],
    });
    const logging = await createTestServer({
      modules: [EchoModule],
      overrides: [provide(Logger, { useValue: loud })],
      requestLogging: true,
    });

    try {
      await silent.json('echo');
      await logging.json('echo');

      expect(quiet.entries).toEqual([]);
      expect(loud.at(LogLevel.INFO)).toHaveLength(1);
    } finally {
      await silent.close();
      await logging.close();
    }
  });

  it('stops the server and tears the container down on close()', async () => {
    const fixture = await createTestServer({ modules: [EchoModule] });
    const { url } = fixture;

    await fixture.close();
    await fixture.app.closed;

    expect(await rejectionMessage(fetch(new URL('echo', url)))).toBeTruthy();
  });
});

class DenyGuard implements Middleware {
  handle(): Promise<Response> {
    throw new HttpError(401, 'UNAUTHORIZED');
  }
}

@Controller('open')
class OpenController {
  @Get('/')
  ok(): { ok: true } {
    return { ok: true };
  }
}

// Exported, because the harness composes these under a synthetic root and global
// middleware resolves as that root sees it - the same rule production follows.
@Module({
  controllers: [OpenController],
  providers: [DenyGuard],
  exports: [DenyGuard],
})
class GlobalGuardModule {}

@Controller('scoped')
@UseGuards(DenyGuard)
class ScopedController {
  @Get('/')
  ok(): { ok: true } {
    return { ok: true };
  }
}

@Module({
  controllers: [ScopedController],
  providers: [DenyGuard],
  exports: [DenyGuard],
})
class ScopedGuardModule {}

class ProvidedMiddleware extends HttpOptionsProvider {
  override readonly middleware = [DenyGuard];
}

@Module({
  controllers: [OpenController],
  providers: [
    DenyGuard,
    provide(HttpOptionsProvider, { useClass: ProvidedMiddleware }),
  ],
  exports: [DenyGuard, HttpOptionsProvider],
})
class ProvidedMiddlewareModule {}

class ProvidedErrorMapper extends HttpOptionsProvider {
  override get onError(): ErrorHandler {
    return () => new Response('mapped', { status: 418 });
  }
}

@Module({
  controllers: [OpenController],
  providers: [
    DenyGuard,
    provide(HttpOptionsProvider, { useClass: ProvidedErrorMapper }),
  ],
  exports: [DenyGuard, HttpOptionsProvider],
})
class ProvidedErrorMapperModule {}

const warnings = async (run: () => Promise<void>): Promise<string[]> => {
  const lines: string[] = [];
  const { warn } = console;
  console.warn = (...args: unknown[]): void => {
    lines.push(args.map(String).join(' '));
  };
  try {
    await run();
  } finally {
    console.warn = warn;
  }
  return lines;
};

/**
 * The failure this exists for: a suite that forgets `middleware` boots a server
 * with no global guards and no error mapper, answers 200 where production answers
 * 401, and says nothing about it.
 */
describe('createTestServer() global middleware', () => {
  it('warns when the graph declares middleware and none was supplied', async () => {
    let fixture: TestServer | undefined;
    const lines = await warnings(async () => {
      fixture = await createTestServer({ modules: [GlobalGuardModule] });
    });

    try {
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('DenyGuard');
      expect(lines[0]).toContain('middleware');
      // The point of the warning: this 200 is not what production answers.
      expect((await fixture!.json('open')).status).toBe(200);
    } finally {
      await fixture?.close();
    }
  });

  it('says nothing once middleware is supplied, empty included', async () => {
    const supplied: TestServer[] = [];
    const lines = await warnings(async () => {
      supplied.push(
        await createTestServer({
          modules: [GlobalGuardModule],
          middleware: [DenyGuard],
        }),
        await createTestServer({
          modules: [GlobalGuardModule],
          middleware: [],
        }),
      );
    });

    try {
      expect(lines).toEqual([]);
      expect((await supplied[0]!.request('open')).status).toBe(401);
    } finally {
      for (const server of supplied) await server.close();
    }
  });

  it('says nothing about a guard @UseGuards already applies', async () => {
    let fixture: TestServer | undefined;
    const lines = await warnings(async () => {
      fixture = await createTestServer({ modules: [ScopedGuardModule] });
    });

    try {
      expect(lines).toEqual([]);
      // Route-level guards are in the route table, so the fixture is the app.
      expect((await fixture!.request('scoped')).status).toBe(401);
    } finally {
      await fixture?.close();
    }
  });

  /**
   * Since 3.1.0 the argument is not the only source of global middleware, so a
   * fixture whose module binds an `HttpOptionsProvider` is the application. The
   * warning read the argument alone and fired anyway, telling an app that had
   * taken the upgrading guide's advice to undo it.
   */
  it('says nothing when an HttpOptionsProvider supplied the middleware', async () => {
    let fixture: TestServer | undefined;
    const lines = await warnings(async () => {
      fixture = await createTestServer({ modules: [ProvidedMiddlewareModule] });
    });

    try {
      expect(lines).toEqual([]);
      // The guard the warning would have claimed was not running.
      expect((await fixture!.request('open')).status).toBe(401);
    } finally {
      await fixture?.close();
    }
  });

  it('does not call the mapper default when a provider supplied one', async () => {
    let fixture: TestServer | undefined;
    const lines = await warnings(async () => {
      fixture = await createTestServer({
        modules: [ProvidedErrorMapperModule],
      });
    });

    try {
      // Middleware is still unsupplied, so the warning is right to fire.
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('DenyGuard');
      // ...but this app's errors do not reach the default mapper.
      expect(lines[0]).not.toContain('`onError` is the default mapper');
      expect(lines[0]).toContain('HttpOptionsProvider');
    } finally {
      await fixture?.close();
    }
  });
});

describe('createTestServer() and gateways', () => {
  @Gateway('/chat')
  class ChatGateway {
    @OnMessage()
    raw(message: string | Buffer): string {
      return `echo:${String(message)}`;
    }
  }

  @Module({ providers: [ChatGateway] })
  class GatewayModule {}

  /** Open a socket, or say which way it failed rather than hanging. */
  const open = (base: string, path: string): Promise<string> => {
    const socket = new WebSocket(
      new URL(path, base).href.replace('http', 'ws'),
    );
    return new Promise<string>((resolve) => {
      const timer = setTimeout(() => resolve('TIMEOUT'), 2000);
      const settle = (outcome: string) => {
        clearTimeout(timer);
        socket.close();
        resolve(outcome);
      };
      socket.addEventListener('open', () => settle('opened'), { once: true });
      socket.addEventListener('error', () => settle('refused'), { once: true });
    });
  };

  it('serves a gateway on the url it returned', async () => {
    // `gatewayPort` is not forced: forcing it moved the upgrades to a second
    // server, so a fixture opening a socket on `server.url` was refused.
    const server = await createTestServer({ modules: [GatewayModule] });

    expect(server.gatewayUrl).toBeUndefined();
    expect(await open(server.url, '/chat')).toBe('opened');
    await server.close();
  });

  it('splits the ports when a suite asks for it', async () => {
    const server = await createTestServer({
      modules: [GatewayModule],
      gatewayPort: 0,
    });

    expect(server.gatewayUrl).toBeString();
    expect(await open(server.gatewayUrl as string, '/chat')).toBe('opened');
    await server.close();
  });
});
