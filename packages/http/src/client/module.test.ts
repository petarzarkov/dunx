import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import {
  AppFactory,
  ConfigModule,
  ConfigService,
  inject,
  Module,
  provide,
  token,
} from '@dunx/core';
import { HttpClientOptions } from './options.js';
import { httpClient, HttpModule } from './module.js';
import { HttpService } from './service.js';

interface Path {
  readonly path: string;
}

interface Agent {
  readonly agent: string | null;
}

let server: ReturnType<typeof Bun.serve>;
let base: string;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch: (request) => {
      const url = new URL(request.url);
      // `/echo` reports a header back, which is how a test tells two clients
      // apart from outside: `options` is private, so the configuration itself
      // is not readable.
      return url.pathname === '/echo'
        ? Response.json({ agent: request.headers.get('x-client') })
        : Response.json({ path: url.pathname });
    },
  });
  base = server.url.href;
});

afterAll(async () => {
  await server.stop(true);
});

describe('HttpModule.forRoot', () => {
  it('binds HttpService with core Logger and RequestContext, and no logging module', async () => {
    @Module({
      imports: [HttpModule.forRoot({ baseUrl: 'https://example.test' })],
    })
    class AppModule {}

    const app = await AppFactory.create(AppModule);
    const http = app.get(HttpService);

    expect(http).toBeInstanceOf(HttpService);
    expect(app.get(HttpClientOptions).baseUrl).toBe('https://example.test');
    // `UrlHelper` came along, so buildUrl is on the service.
    expect(http.buildUrl({ base: 'https://a.test', path: 'b' }).href).toBe(
      'https://a.test/b',
    );
    await app.shutdown();
  });

  it('reaches a real upstream through the container', async () => {
    @Module({ imports: [HttpModule.forRoot({ baseUrl: base })] })
    class AppModule {}

    const app = await AppFactory.create(AppModule);
    expect(await app.get(HttpService).get<Path>('/wired')).toEqual({
      path: '/wired',
    });
    await app.shutdown();
  });

  it('applies the documented defaults', async () => {
    @Module({ imports: [HttpModule.forRoot()] })
    class AppModule {}

    const app = await AppFactory.create(AppModule);
    const options = app.get(HttpClientOptions);
    expect(options.timeoutMs).toBe(30_000);
    expect(options.requestIdHeader).toBe('x-request-id');
    expect(options.baseUrl).toBeUndefined();
    await app.shutdown();
  });

  /** Only the keys actually set, since Bun reads presence rather than value. */
  it('passes through only the Bun fetch extras that were given', async () => {
    const options = new HttpClientOptions({ proxy: 'http://proxy.test:8080' });
    expect(options.fetchOptions).toEqual({ proxy: 'http://proxy.test:8080' });
    expect(new HttpClientOptions({}).fetchOptions).toEqual({});
  });
});

describe('HttpModule.forRootAsync', () => {
  it('reads its options off ConfigService, which forRoot cannot', async () => {
    interface AppConfig {
      readonly upstream: string;
    }
    class AppConfigService extends ConfigService<AppConfig> {}

    @Module({
      imports: [
        ConfigModule.forRoot({
          validate: () => ({ upstream: base }),
          as: AppConfigService,
          source: {},
        }),
        HttpModule.forRootAsync({
          useFactory: (config: AppConfigService) => ({
            baseUrl: config.get('upstream'),
            timeoutMs: 1234,
          }),
          inject: [AppConfigService] as const,
        }),
      ],
    })
    class AppModule {}

    const app = await AppFactory.create(AppModule);
    expect(app.get(HttpClientOptions).timeoutMs).toBe(1234);
    expect(await app.get(HttpService).get<Path>('/from-config')).toEqual({
      path: '/from-config',
    });
    await app.shutdown();
  });

  /**
   * The scoped-container case: this dynamic module is its own scope, so a factory
   * cannot see a provider merely because the module calling `forRootAsync` imports
   * it. `imports` here is what puts it in reach.
   *
   * A `token()` rather than a class: an unbound class self-binds into whichever
   * scope asks first, so a class resolves whether or not `imports` reached the
   * factory, and the test would pass against the bug it guards.
   */
  it('injects from a module named in its own imports', async () => {
    const BASE = token<string>('UpstreamBase');

    @Module({
      providers: [provide(BASE, { useValue: base })],
      exports: [BASE],
    })
    class UpstreamModule {}

    @Module({
      imports: [
        HttpModule.forRootAsync({
          imports: [UpstreamModule],
          useFactory: (baseUrl: string) => ({ baseUrl, timeoutMs: 555 }),
          inject: [BASE],
        }),
      ],
    })
    class AppModule {}

    const app = await AppFactory.create(AppModule);

    expect(app.get(HttpClientOptions).timeoutMs).toBe(555);
    expect(await app.get(HttpService).get<Path>('/scoped')).toEqual({
      path: '/scoped',
    });
    await app.shutdown();
  });

  it('forwards those imports to a named client too', async () => {
    const BASE = token<string>('UpstreamBase');

    @Module({
      providers: [provide(BASE, { useValue: base })],
      exports: [BASE],
    })
    class UpstreamModule {}

    class Caller {
      readonly billing = inject(httpClient('billing'));
    }

    @Module({
      imports: [
        HttpModule.forRootAsync(
          {
            imports: [UpstreamModule],
            useFactory: (baseUrl: string) => ({ baseUrl, timeoutMs: 666 }),
            inject: [BASE],
          },
          'billing',
        ),
      ],
      providers: [Caller],
    })
    class AppModule {}

    const app = await AppFactory.create(AppModule);

    expect(await app.get(Caller).billing.get<Path>('/billing')).toEqual({
      path: '/billing',
    });
    await app.shutdown();
  });

  it('accepts a bare async loader', async () => {
    @Module({
      imports: [
        HttpModule.forRootAsync(async () => {
          await Bun.sleep(1);
          return { baseUrl: base, timeoutMs: 4321 };
        }),
      ],
    })
    class AppModule {}

    const app = await AppFactory.create(AppModule);
    expect(app.get(HttpClientOptions).timeoutMs).toBe(4321);
    await app.shutdown();
  });
});

/**
 * A service talking to two upstreams needs two configured clients, and the flat
 * container reports a second `HttpClientOptions` as a duplicate binding - which is
 * why a named client binds its own options token.
 */
describe('named clients', () => {
  it('returns the same token for the same name', () => {
    expect(httpClient('stripe')).toBe(httpClient('stripe'));
    expect(httpClient('stripe')).not.toBe(httpClient('billing'));
  });

  it('lets two upstreams coexist alongside one default', async () => {
    class Callers {
      readonly stripe = inject(httpClient('stripe'));
      readonly billing = inject(httpClient('billing'));
    }

    @Module({
      imports: [
        HttpModule.forRoot({ baseUrl: base }),
        HttpModule.forRoot({ name: 'stripe', baseUrl: base, timeoutMs: 11 }),
        HttpModule.forRootAsync(
          () => ({ baseUrl: base, timeoutMs: 22 }),
          'billing',
        ),
      ],
      providers: [Callers],
    })
    class AppModule {}

    const app = await AppFactory.create(AppModule);
    const callers = app.get(Callers);

    expect(await callers.stripe.get<Path>('/stripe')).toEqual({
      path: '/stripe',
    });
    expect(await callers.billing.get<Path>('/billing')).toEqual({
      path: '/billing',
    });
    // The default is still its own binding.
    expect(app.get(HttpService)).not.toBe(callers.stripe);
    await app.shutdown();
  });

  it('does not claim HttpService when named', async () => {
    @Module({ imports: [HttpModule.forRoot({ name: 'only', baseUrl: base })] })
    class AppModule {}

    const app = await AppFactory.create(AppModule);
    expect(() => app.get(HttpService)).toThrow();
    await app.shutdown();
  });
});

/**
 * W6: a named client as a subclass, so it can be a constructor parameter. A
 * `Token` never can, which forced `inject()` in a field on every consumer.
 */
describe('a client registered as a subclass', () => {
  class EmailClient extends HttpService {}
  class BillingClient extends HttpService {}

  it('resolves as a constructor parameter', async () => {
    class Notifier {
      constructor(readonly email: EmailClient) {}
    }

    @Module({
      imports: [
        HttpModule.forRoot(
          { baseUrl: base, headers: { 'x-client': 'email' } },
          EmailClient,
        ),
      ],
      providers: [
        // The suite runs without `@dunx/transform`, so the parameter type is not
        // recorded. An app with the preload writes `providers: [Notifier]` and
        // the constructor above is all there is to it.
        provide(Notifier, {
          useFactory: (email: EmailClient) => new Notifier(email),
          inject: [EmailClient] as const,
        }),
      ],
    })
    class AppModule {}

    const app = await AppFactory.create(AppModule);
    // The instance is the subclass, not an `HttpService` under a subclass token.
    expect(app.get(Notifier).email).toBeInstanceOf(EmailClient);
    expect(await app.get(Notifier).email.get<Path>('/mail')).toEqual({
      path: '/mail',
    });
    await app.shutdown();
  });

  it('does not claim HttpService, so a default coexists', async () => {
    @Module({
      imports: [
        HttpModule.forRoot({
          baseUrl: base,
          headers: { 'x-client': 'default' },
        }),
        HttpModule.forRoot(
          { baseUrl: base, headers: { 'x-client': 'email' } },
          EmailClient,
        ),
      ],
    })
    class AppModule {}

    const app = await AppFactory.create(AppModule);
    expect(app.get(HttpService)).not.toBeInstanceOf(EmailClient);
    expect(await app.get(HttpService).get<Agent>('/echo')).toEqual({
      agent: 'default',
    });
    expect(await app.get(EmailClient).get<Agent>('/echo')).toEqual({
      agent: 'email',
    });
    await app.shutdown();
  });

  it('gives two subclasses their own options', async () => {
    @Module({
      imports: [
        HttpModule.forRoot(
          { baseUrl: base, headers: { 'x-client': 'email' } },
          EmailClient,
        ),
        HttpModule.forRootAsync(
          () => ({ baseUrl: base, headers: { 'x-client': 'billing' } }),
          BillingClient,
        ),
      ],
    })
    class AppModule {}

    const app = await AppFactory.create(AppModule);
    // Each binds its own `HttpClientOptions(<class name>)` token, which is what
    // stops the second registration reading as a duplicate binding.
    expect(await app.get(EmailClient).get<Agent>('/echo')).toEqual({
      agent: 'email',
    });
    expect(await app.get(BillingClient).get<Agent>('/echo')).toEqual({
      agent: 'billing',
    });
    expect(app.get(EmailClient)).not.toBe(app.get(BillingClient));
    await app.shutdown();
  });

  it('reaches a factory’s own imports', async () => {
    const BASE = token<string>('SubclassBase');

    @Module({
      providers: [provide(BASE, { useValue: base })],
      exports: [BASE],
    })
    class UpstreamModule {}

    @Module({
      imports: [
        HttpModule.forRootAsync(
          {
            imports: [UpstreamModule],
            useFactory: (baseUrl: string) => ({
              baseUrl,
              headers: { 'x-client': 'from-imports' },
            }),
            inject: [BASE],
          },
          BillingClient,
        ),
      ],
    })
    class AppModule {}

    const app = await AppFactory.create(AppModule);
    expect(await app.get(BillingClient).get<Agent>('/echo')).toEqual({
      agent: 'from-imports',
    });
    await app.shutdown();
  });

  it('leaves the string form working', async () => {
    class Caller {
      readonly stripe = inject(httpClient('legacy-stripe'));
    }

    @Module({
      imports: [
        HttpModule.forRoot({
          name: 'legacy-stripe',
          baseUrl: base,
          headers: { 'x-client': 'legacy' },
        }),
      ],
      providers: [Caller],
    })
    class AppModule {}

    const app = await AppFactory.create(AppModule);
    expect(await app.get(Caller).stripe.get<Agent>('/echo')).toEqual({
      agent: 'legacy',
    });
    await app.shutdown();
  });
});
