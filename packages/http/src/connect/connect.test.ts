import { afterEach, describe, expect, it } from 'bun:test';
import { Module, provide, token } from '@dunx/core';
import { createClient } from '@connectrpc/connect';
import {
  createConnectTransport,
  createGrpcWebTransport,
} from '@connectrpc/connect-web';
import type { BunRequest } from 'bun';
import type { HttpMethod } from '../route/marker.js';
import { UNMATCHED, type MetaKey } from '../route/metadata.js';
import type { RouteContext } from '../server/context.js';
import { Controller, Get } from '../route/decorators.js';
import { HttpFactory, type HttpApp } from '../server/factory.js';
import { ConnectMiddleware } from './middleware.js';
import { ConnectModule } from './module.js';
import { connectService, ConnectOptions } from './options.js';
import { ConnectRegistry } from './registry.js';
import {
  CapturingRpc,
  GreetRpc,
  GreetService,
  SlowRpc,
} from './greet.fixture.js';

const SAY = '/greet.v1.GreetService/Say';
const COUNTDOWN = '/greet.v1.GreetService/Countdown';

/** The shape `buildFallback` hands a middleware for a path nothing matched. */
const unmatched = (path: string, isUnmatched = true): RouteContext =>
  Object.freeze({
    controller: '(unmatched)',
    handler: '(none)',
    method: 'POST' as HttpMethod,
    path,
    parsesBody: false,
    get: <T>(key: MetaKey<T>): T | undefined =>
      isUnmatched && key.id === UNMATCHED.id ? (true as T) : undefined,
  });

const post = (path: string, contentType: string, body = '{}'): BunRequest =>
  new Request(`http://rpc.test${path}`, {
    method: 'POST',
    headers: { 'content-type': contentType },
    body,
  }) as BunRequest;

/** A streaming request body is enveloped: one flag byte, four length bytes big
 * endian, then the message. */
const stream = (path: string, message: string): BunRequest => {
  const payload = new TextEncoder().encode(message);
  const frame = new Uint8Array(5 + payload.length);
  new DataView(frame.buffer).setUint32(1, payload.length);
  frame.set(payload, 5);
  return new Request(`http://rpc.test${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/connect+json' },
    body: frame,
  }) as BunRequest;
};

const registryFor = (
  prefix = '',
  impl: object = new GreetRpc(),
): ConnectRegistry =>
  new ConnectRegistry(
    new ConnectOptions({
      services: [connectService(GreetService, GreetRpc)],
      prefix,
    }),
    [impl],
  );

describe('the mount prefix', () => {
  const at = (prefix: string): string =>
    new ConnectOptions({
      services: [connectService(GreetService, GreetRpc)],
      prefix,
    }).prefix;

  it('leaves an empty prefix empty, which is where clients look', () => {
    expect(at('')).toBe('');
    expect(at('/')).toBe('');
  });

  it('adds the leading slash and drops the trailing one', () => {
    expect(at('api')).toBe('/api');
    expect(at('/api/')).toBe('/api');
    expect(at('//api//v1//')).toBe('/api/v1');
  });
});

describe('ConnectOptions', () => {
  const services = [connectService(GreetService, GreetRpc)];

  it('serves both body-framed protocols by default and never gRPC', () => {
    const options = new ConnectOptions({ services });
    expect(options.connect).toBe(true);
    expect(options.grpcWeb).toBe(true);
    expect(options.prefix).toBe('');
    expect(options.router).toEqual({});
  });

  it('keeps every other router setting as a passthrough', () => {
    const options = new ConnectOptions({
      services,
      prefix: '/rpc',
      readMaxBytes: 1024,
      requireConnectProtocolHeader: true,
    });
    expect(options.prefix).toBe('/rpc');
    expect(options.router).toEqual({
      readMaxBytes: 1024,
      requireConnectProtocolHeader: true,
    });
  });

  it('refuses a configuration with no protocol left', () => {
    expect(
      () => new ConnectOptions({ services, connect: false, grpcWeb: false }),
    ).toThrow(/at least one protocol/);
  });

  it('refuses an empty service list', () => {
    expect(() => new ConnectOptions({ services: [] })).toThrow(/no services/);
  });
});

describe('connectService', () => {
  it('pairs the descriptor with the class serving it', () => {
    const registration = connectService(GreetService, GreetRpc);
    expect(registration.service).toBe(GreetService);
    expect(registration.useClass).toBe(GreetRpc);
  });

  it('rejects a class that does not serve the descriptor', () => {
    class NotGreet {
      hello(): string {
        return 'no';
      }
    }
    // The pairing is what makes the cast in `registry.ts` sound, so the check
    // has to be a compile error rather than a boot one. `tsc --noEmit` fails
    // this file if the line below ever starts type-checking.
    // @ts-expect-error NotGreet implements none of GreetService's methods
    connectService(GreetService, NotGreet);

    class WrongReturn {
      say(): number {
        return 1;
      }
    }
    // @ts-expect-error say must answer the descriptor's response, not a number
    connectService(GreetService, WrongReturn);
  });
});

describe('ConnectRegistry', () => {
  it('mounts one handler per RPC, naming the service, method and kind', () => {
    const registry = registryFor();
    expect(registry.methods).toEqual([
      {
        path: SAY,
        service: 'greet.v1.GreetService',
        method: 'Say',
        kind: 'unary',
        protocols: ['grpc-web', 'connect'],
      },
      {
        path: COUNTDOWN,
        service: 'greet.v1.GreetService',
        method: 'Countdown',
        kind: 'server_streaming',
        protocols: ['grpc-web', 'connect'],
      },
    ]);
  });

  it('never advertises grpc, because Bun.serve sends no trailers', () => {
    for (const method of registryFor().methods) {
      expect(method.protocols).not.toContain('grpc');
    }
  });

  it('puts the prefix in front of every path', () => {
    const registry = registryFor('/rpc');
    expect(registry.methods.map((m) => m.path)).toEqual([
      `/rpc${SAY}`,
      `/rpc${COUNTDOWN}`,
    ]);
    expect(registry.routeFor(`/rpc${SAY}`)).toBeDefined();
    expect(registry.routeFor(SAY)).toBeUndefined();
  });

  it('serves a call through the injected instance, with `this` intact', async () => {
    const registry = registryFor('', new GreetRpc('Howdy'));
    const route = registry.routeFor(SAY);
    const response = await route!.handle(
      post(SAY, 'application/json', JSON.stringify({ name: 'world' })),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ text: 'Howdy world' });
  });

  it('names the class when no instance was resolved for it', () => {
    expect(
      () =>
        new ConnectRegistry(
          new ConnectOptions({
            services: [connectService(GreetService, GreetRpc)],
          }),
          [],
        ),
    ).toThrow(/GreetRpc/);
  });

  it('drops the Connect protocol when it is turned off', async () => {
    const registry = new ConnectRegistry(
      new ConnectOptions({
        services: [connectService(GreetService, GreetRpc)],
        connect: false,
      }),
      [new GreetRpc()],
    );
    expect(registry.methods[0]?.protocols).toEqual(['grpc-web']);
    const refused = await registry
      .routeFor(SAY)!
      .handle(post(SAY, 'application/json'));
    expect(refused.status).toBe(415);
  });

  it('refuses two RPCs mounted at one path, naming both', () => {
    const registration = connectService(GreetService, GreetRpc);
    expect(
      () =>
        new ConnectRegistry(
          new ConnectOptions({ services: [registration, registration] }),
          [new GreetRpc(), new GreetRpc()],
        ),
    ).toThrow(/RPC collision: \/greet\.v1\.GreetService\/Say is declared by/);
  });

  it('defaults streamTimeout to 0 and refuses a negative one', () => {
    const registration = connectService(GreetService, GreetRpc);
    expect(new ConnectOptions({ services: [registration] }).streamTimeout).toBe(
      0,
    );
    expect(
      new ConnectOptions({ services: [registration], streamTimeout: 30 })
        .streamTimeout,
    ).toBe(30);
    expect(
      () => new ConnectOptions({ services: [registration], streamTimeout: -1 }),
    ).toThrow(/non-negative/);
  });

  it('marks a streaming RPC, which is what clears the idle timeout', () => {
    const registry = registryFor();
    expect(registry.routeFor(SAY)?.streaming).toBe(false);
    expect(registry.routeFor(COUNTDOWN)?.streaming).toBe(true);
  });

  it('aborts the signal a running handler holds when the app shuts down', async () => {
    const implementation = new CapturingRpc();
    const registry = registryFor('', implementation);
    const response = await registry
      .routeFor(COUNTDOWN)!
      .handle(stream(COUNTDOWN, '{}'));
    const reader = response.body!.getReader();
    // The first message, so the generator is suspended mid-call rather than
    // finished - connect aborts the per-call controller when a call completes.
    await reader.read();
    expect(implementation.signal?.aborted).toBe(false);

    registry.onShutdown();
    expect(implementation.signal?.aborted).toBe(true);
    await reader.cancel();
  });
});

describe('ConnectMiddleware', () => {
  const middleware = (registry = registryFor()): ConnectMiddleware =>
    new ConnectMiddleware(registry);

  const passthrough = async (): Promise<Response> =>
    new Response('next', { status: 418 });

  it('passes a matched route straight through', async () => {
    const response = await middleware().handle(
      post(SAY, 'application/json'),
      unmatched(SAY, false),
      passthrough,
    );
    expect(response.status).toBe(418);
  });

  it('passes an unmatched path it does not serve straight through', async () => {
    const response = await middleware().handle(
      post('/nope', 'application/json'),
      unmatched('/nope'),
      passthrough,
    );
    expect(response.status).toBe(418);
  });

  it('serves a registered path', async () => {
    const response = await middleware().handle(
      post(SAY, 'application/json', JSON.stringify({ name: 'dunx' })),
      unmatched(SAY),
      passthrough,
    );
    expect(await response.json()).toEqual({ text: 'Hello dunx' });
  });

  it('explains itself to a native gRPC caller instead of half-answering', async () => {
    for (const contentType of [
      'application/grpc',
      'application/grpc+proto',
      'application/grpc; charset=utf-8',
      'APPLICATION/GRPC',
    ]) {
      const response = await middleware().handle(
        post(SAY, contentType),
        unmatched(SAY),
        passthrough,
      );
      expect(response.status).toBe(415);
      const body = (await response.json()) as { message: string };
      expect(body.message).toContain('trailer');
    }
  });

  it('does not mistake gRPC-Web for gRPC', async () => {
    const response = await middleware().handle(
      post(SAY, 'application/grpc-web+proto'),
      unmatched(SAY),
      passthrough,
    );
    expect(response.status).not.toBe(415);
  });

  it('serves a request with no content-type to Connect', async () => {
    const response = await middleware().handle(
      new Request(`http://rpc.test${SAY}`, {
        method: 'POST',
        body: '{}',
      }) as BunRequest,
      unmatched(SAY),
      passthrough,
    );
    expect(response.status).toBe(415);
  });
});

describe('ConnectModule', () => {
  let app: HttpApp | undefined;

  afterEach(async () => {
    await app?.shutdown();
    app = undefined;
  });

  const boot = async (module: unknown): Promise<string> => {
    app = await HttpFactory.create(module as never, {
      bootLogging: false,
      requestLogging: false,
    });
    app.use(ConnectMiddleware);
    return app.listen(0);
  };

  it('answers a CORS preflight on an RPC path', async () => {
    @Module({
      imports: [
        ConnectModule.forRoot({
          services: [connectService(GreetService, GreetRpc)],
        }),
      ],
    })
    class CorsModule {}

    app = await HttpFactory.create(CorsModule as never, {
      bootLogging: false,
      requestLogging: false,
    });
    app.use(ConnectMiddleware);
    app.enableCors({ origin: 'https://app.example' });
    const url = await app.listen(0);

    const res = await fetch(`${url}${SAY}`, {
      method: 'OPTIONS',
      headers: {
        origin: 'https://app.example',
        'access-control-request-method': 'POST',
      },
    });

    // `preflight` is mounted over the route table, which an RPC path is not in,
    // so without one built here a browser gRPC-Web call never gets past this.
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-methods')).toContain('POST');
    expect(res.headers.get('access-control-allow-origin')).toBe(
      'https://app.example',
    );
  });

  it('refuses a controller route that would shadow an RPC path', async () => {
    @Controller('/')
    class Shadow {
      @Get(SAY as never)
      say(): string {
        return 'shadowed';
      }
    }

    @Module({
      controllers: [Shadow],
      imports: [
        ConnectModule.forRoot({
          services: [connectService(GreetService, GreetRpc)],
        }),
      ],
    })
    class ShadowModule {}

    // Bun matches the route, so the middleware would never see the call.
    await expect(boot(ShadowModule)).rejects.toThrow(
      /Path collision: .*GreetService\/Say is declared by Shadow\.say/,
    );
  });

  it('binds the registry, the options and the middleware', async () => {
    @Module({
      imports: [
        ConnectModule.forRoot({
          services: [connectService(GreetService, GreetRpc)],
        }),
      ],
    })
    class AppModule {}

    await boot(AppModule);
    expect(app?.get(ConnectOptions).prefix).toBe('');
    expect(app?.get(ConnectRegistry).methods).toHaveLength(2);
    expect(app?.get(ConnectMiddleware)).toBeInstanceOf(ConnectMiddleware);
  });

  it('answers a Connect client over the wire, unary and streaming', async () => {
    @Module({
      imports: [
        ConnectModule.forRoot({
          services: [connectService(GreetService, GreetRpc)],
        }),
      ],
    })
    class AppModule {}

    const baseUrl = await boot(AppModule);
    const client = createClient(
      GreetService,
      createConnectTransport({ baseUrl }),
    );

    expect((await client.say({ name: 'connect' })).text).toBe('Hello connect');

    const ticks: string[] = [];
    for await (const message of client.countdown({ name: 'tick' })) {
      ticks.push(message.text);
    }
    expect(ticks).toEqual(['tick 3', 'tick 2', 'tick 1']);
  });

  it('answers a gRPC-Web client over the same port', async () => {
    @Module({
      imports: [
        ConnectModule.forRoot({
          services: [connectService(GreetService, GreetRpc)],
        }),
      ],
    })
    class AppModule {}

    const baseUrl = await boot(AppModule);
    const client = createClient(
      GreetService,
      createGrpcWebTransport({ baseUrl }),
    );

    expect((await client.say({ name: 'web' })).text).toBe('Hello web');

    const ticks: string[] = [];
    for await (const message of client.countdown({ name: 'gw' })) {
      ticks.push(message.text);
    }
    expect(ticks).toEqual(['gw 3', 'gw 2', 'gw 1']);
  });

  it('answers a plain JSON POST, which is what curl sends', async () => {
    @Module({
      imports: [
        ConnectModule.forRoot({
          services: [connectService(GreetService, GreetRpc)],
        }),
      ],
    })
    class AppModule {}

    const baseUrl = await boot(AppModule);
    const response = await fetch(new URL(SAY.slice(1), baseUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'curl' }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ text: 'Hello curl' });
  });

  /**
   * Without the deadline being cleared this call loses its second message and the
   * client reads `ECONNRESET`.
   *
   * The gap is 16s, and the number matters. `Bun.serve` severs an idle response
   * on a 4 second timer, so the default `idleTimeout: 10` cuts at 12.0s, not at
   * 10 - an earlier 11s version of this test passed with the fix removed. 16s
   * leaves a full timer tick of margin below, and nothing above: `keepAlive`
   * clears the deadline outright, so a loaded machine stretching the sleep only
   * makes the unfixed case fail harder. Those 16 seconds are what it costs.
   */
  it('keeps a stream alive across a pause longer than the idle timeout', async () => {
    @Module({
      imports: [
        ConnectModule.forRoot({
          services: [connectService(GreetService, SlowRpc)],
        }),
      ],
    })
    class AppModule {}

    const baseUrl = await boot(AppModule);
    const client = createClient(
      GreetService,
      createConnectTransport({ baseUrl }),
    );

    const texts: string[] = [];
    for await (const message of client.countdown({ name: 'slow' })) {
      texts.push(message.text);
    }
    expect(texts).toEqual(['slow first', 'slow second']);
  }, 40_000);

  it('still answers 404 for a path no RPC and no route claims', async () => {
    @Module({
      imports: [
        ConnectModule.forRoot({
          services: [connectService(GreetService, GreetRpc)],
        }),
      ],
    })
    class AppModule {}

    const baseUrl = await boot(AppModule);
    const response = await fetch(new URL('nothing/here', baseUrl));
    expect(response.status).toBe(404);
  });

  it('serves under a prefix when one is set', async () => {
    @Module({
      imports: [
        ConnectModule.forRoot({
          services: [connectService(GreetService, GreetRpc)],
          prefix: '/rpc',
        }),
      ],
    })
    class AppModule {}

    const baseUrl = await boot(AppModule);
    const client = createClient(
      GreetService,
      createConnectTransport({ baseUrl: new URL('rpc', baseUrl).href }),
    );
    expect((await client.say({ name: 'prefixed' })).text).toBe(
      'Hello prefixed',
    );
  });
});

describe('ConnectModule.forRootAsync', () => {
  let app: HttpApp | undefined;

  afterEach(async () => {
    await app?.shutdown();
    app = undefined;
  });

  /** A token, never a class: an unbound class self-binds into whichever scope
   * asks first, so a class would resolve whether or not `imports` reached the
   * factory and the test would pass against the bug it guards. */
  const PREFIX = token<string>('rpc.prefix');

  @Module({
    providers: [provide(PREFIX, { useValue: '/async' })],
    exports: [PREFIX],
  })
  class PrefixModule {}

  it('reaches a provider its own imports declare', async () => {
    @Module({
      imports: [
        ConnectModule.forRootAsync([connectService(GreetService, GreetRpc)], {
          imports: [PrefixModule],
          useFactory: (prefix: string) => ({ prefix }),
          inject: [PREFIX] as const,
        }),
      ],
    })
    class AppModule {}

    app = await HttpFactory.create(AppModule, {
      bootLogging: false,
      requestLogging: false,
    });
    app.use(ConnectMiddleware);
    const baseUrl = await app.listen(0);

    expect(app.get(ConnectOptions).prefix).toBe('/async');
    const response = await fetch(new URL(`async${SAY}`, baseUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'late' }),
    });
    expect(await response.json()).toEqual({ text: 'Hello late' });
  });

  it('works with no imports and no inject', async () => {
    @Module({
      imports: [
        ConnectModule.forRootAsync([connectService(GreetService, GreetRpc)], {
          useFactory: () => ({ prefix: '/bare' }),
        }),
      ],
    })
    class AppModule {}

    app = await HttpFactory.create(AppModule, {
      bootLogging: false,
      requestLogging: false,
    });
    expect(app.get(ConnectOptions).prefix).toBe('/bare');
  });
});
