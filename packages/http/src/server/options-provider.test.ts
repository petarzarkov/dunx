import { describe, expect, it } from 'bun:test';
import {
  ConfigModule,
  ConfigService,
  Module,
  provide,
  type Registration,
} from '@dunx/core';
import { Controller, Get, Post } from '../route/decorators.js';
import { HttpFactory } from './factory.js';
import { captured } from './request-logging.fixture.test.js';
import { HttpOptionsProvider } from './options-provider.js';
import type { RequestLoggingOptions } from './request-logging.js';

@Controller('users')
class UsersController {
  @Get()
  list(): readonly string[] {
    return ['ada'];
  }
}

@Controller('things')
class ThingsController {
  @Post()
  create(): { readonly ok: boolean } {
    return { ok: true };
  }
}

interface AppEnv {
  readonly prefix: string;
  readonly logBodies: boolean;
}

class AppConfig extends ConfigService<AppEnv> {}

const config = (source: Record<string, string>) =>
  ConfigModule.forRoot({
    as: AppConfig,
    source,
    validate: (env): AppEnv => ({
      prefix: String(env['API_PREFIX'] ?? ''),
      logBodies: env['LOG_BODIES'] === 'true',
    }),
  });

/**
 * The whole reason this contract exists: settings that come from validated
 * config, which an argument to `HttpFactory.create` cannot reach because the
 * container does not exist yet when that argument is built.
 */
class AppHttpOptions extends HttpOptionsProvider {
  constructor(private readonly settings: AppConfig) {
    super();
  }

  override get prefix(): string {
    return this.settings.get('prefix');
  }

  override get requestLogging(): RequestLoggingOptions {
    return { requestBody: this.settings.get('logBodies') };
  }
}

/**
 * `useFactory` rather than `useClass`, because this suite runs without
 * `@dunx/transform`'s preload - so a constructor parameter type is not recorded
 * and the container has nothing to resolve. An app with the preload writes
 * `provide(HttpOptionsProvider, { useClass: AppHttpOptions })`.
 */
const bindProvider = (): Registration =>
  provide(HttpOptionsProvider, {
    useFactory: (settings: AppConfig) => new AppHttpOptions(settings),
    inject: [AppConfig] as const,
  });

const appWith = async (
  providers: readonly Registration[],
  source: Record<string, string> = { API_PREFIX: '/api/v1' },
) => {
  @Module({
    imports: [config(source)],
    controllers: [UsersController, ThingsController],
    providers: [...providers],
  })
  class AppModule {}

  return HttpFactory.create(AppModule, { port: 0 });
};

describe('HttpOptionsProvider', () => {
  it('supplies a setting the create() argument could not have known', async () => {
    const app = await appWith([bindProvider()]);
    const url = await app.listen(0);

    // `/api/v1` came out of the validated env, through the container, into the
    // route table. Nothing in main.ts read the environment a second time.
    const prefixed = await fetch(new URL('/api/v1/users', url));
    const bare = await fetch(new URL('/users', url));
    await app.shutdown();

    expect(prefixed.status).toBe(200);
    expect(await prefixed.json()).toEqual(['ada']);
    expect(bare.status).toBe(404);
  });

  it('defaults every setting when no module binds one', async () => {
    const app = await appWith([]);
    const url = await app.listen(0);
    const response = await fetch(new URL('/users', url));
    await app.shutdown();

    // No prefix, and the app still serves - which is what keeps this additive
    // for every app written before the contract existed.
    expect(response.status).toBe(200);
  });

  it('lets the create() argument win over the provider, field by field', async () => {
    @Module({
      imports: [config({ API_PREFIX: '/from-config' })],
      controllers: [UsersController, ThingsController],
      providers: [bindProvider()],
    })
    class AppModule {}

    const app = await HttpFactory.create(AppModule, {
      port: 0,
      prefix: '/from-argument',
    });
    const url = await app.listen(0);
    const argument = await fetch(new URL('/from-argument/users', url));
    const provider = await fetch(new URL('/from-config/users', url));
    await app.shutdown();

    // An argument already meant something before this contract existed. If the
    // provider won, binding one would silently change what an existing main.ts
    // does - so the argument stays the more specific of the two.
    expect(argument.status).toBe(200);
    expect(provider.status).toBe(404);
  });

  it('reads a setting the argument left unmentioned from the provider', async () => {
    @Module({
      imports: [config({ API_PREFIX: '/p', LOG_BODIES: 'true' })],
      controllers: [UsersController, ThingsController],
      providers: [bindProvider()],
    })
    class AppModule {}

    const entries = await captured(async () => {
      const app = await HttpFactory.create(AppModule, {
        port: 0,
        prefix: '/argument',
      });
      const url = await app.listen(0);
      await fetch(new URL('/argument/things', url), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'ada' }),
      });
      await app.shutdown();
    });

    const entry = entries.find((line) =>
      String(line['message']).startsWith('POST /argument/things'),
    );
    // `prefix` came from the argument and `requestBody` from the provider's
    // `LOG_BODIES`, in the same boot. That is what "field by field" has to mean
    // for an app to move settings into the container one at a time.
    expect(entry).toBeDefined();
    expect(
      (entry?.['request'] as Record<string, unknown> | undefined)?.['body'],
    ).toEqual({ name: 'ada' });
  });
});
