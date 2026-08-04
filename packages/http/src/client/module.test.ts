import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import {
  AppFactory,
  ConfigModule,
  ConfigService,
  inject,
  Module,
} from '@dunx/core';
import { HttpClientOptions } from './options.js';
import { httpClient, HttpModule } from './module.js';
import { HttpService } from './service.js';

interface Path {
  readonly path: string;
}

let server: ReturnType<typeof Bun.serve>;
let base: string;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch: (request) => Response.json({ path: new URL(request.url).pathname }),
  });
  base = server.url.href;
});

afterAll(() => {
  server.stop(true);
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
