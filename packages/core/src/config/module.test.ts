import { describe, expect, it } from 'bun:test';
import { AppFactory } from '../di/app.js';
import { Module } from '../di/module.js';
import { ConfigInput, ConfigModule } from './module.js';
import { ConfigError, ConfigService, type ConfigSource } from './service.js';

interface AppConfig {
  readonly port: number;
  readonly db: { readonly host: string; readonly ssl: boolean };
  readonly sentryDsn?: string;
}

/** Stands in for a zod `.parse` — one function, throwing on bad input. */
const validate = (env: ConfigSource): AppConfig => {
  const port = Number(env['PORT']);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`PORT must be a port number, got ${String(env['PORT'])}`);
  }
  const host = env['DB_HOST'];
  if (!host) throw new Error('DB_HOST is required');

  return {
    port,
    db: { host, ssl: env['DB_SSL'] === 'true' },
    ...(env['SENTRY_DSN'] ? { sentryDsn: env['SENTRY_DSN'] } : {}),
  };
};

const source: ConfigSource = {
  PORT: '3000',
  DB_HOST: 'localhost',
  DB_SSL: 'true',
};

describe('ConfigModule', () => {
  it('validates once at boot and binds the result', async () => {
    @Module({ imports: [ConfigModule.forRoot({ validate, source })] })
    class Root {}

    const app = await AppFactory.create(Root);
    const config = app.get(ConfigService<AppConfig>);

    expect(config.get('port')).toBe(3000);
    expect(config.get('db')).toEqual({ host: 'localhost', ssl: true });
    expect(config.values.db.host).toBe('localhost');
  });

  it('runs validate exactly once, however many injectors read it', async () => {
    let calls = 0;

    @Module({
      imports: [
        ConfigModule.forRoot({
          source,
          validate: (env) => {
            calls += 1;
            return validate(env);
          },
        }),
      ],
    })
    class Root {}

    const app = await AppFactory.create(Root);
    app.get(ConfigService);
    app.get(ConfigService);

    expect(calls).toBe(1);
  });

  it("fails boot with the validator's own error, unwrapped", async () => {
    @Module({
      imports: [
        ConfigModule.forRoot({ validate, source: { DB_HOST: 'localhost' } }),
      ],
    })
    class Root {}

    // The app owns validation, so it owns the message — dunx does not restate it.
    expect(AppFactory.create(Root)).rejects.toThrow(
      'PORT must be a port number, got undefined',
    );
  });

  it('settles an async validate before any constructor runs', async () => {
    class Server {
      readonly port: number;
      constructor(config: ConfigService<AppConfig>) {
        this.port = config.get('port');
      }
    }
    // Stands in for @dunx/compiler, which does not run over this package's tests.
    Object.defineProperty(Server, Symbol.for('dunx.deps'), {
      value: () => [ConfigService],
    });

    @Module({
      imports: [
        ConfigModule.forRoot({
          source,
          validate: async (env) => {
            await Bun.sleep(1);
            return validate(env);
          },
        }),
      ],
      providers: [Server],
    })
    class Root {}

    const app = await AppFactory.create(Root);
    expect(app.get(Server).port).toBe(3000);
  });

  it('defaults its source to Bun.env', async () => {
    @Module({ imports: [ConfigModule.forRoot({ validate: (env) => env })] })
    class Root {}

    const app = await AppFactory.create(Root);
    expect(app.get(ConfigInput)).toBe(Bun.env);
  });

  it('throws from getOrThrow on an unset value, and returns it otherwise', async () => {
    @Module({ imports: [ConfigModule.forRoot({ validate, source })] })
    class Root {}

    const app = await AppFactory.create(Root);
    const config = app.get(ConfigService<AppConfig>);

    expect(config.get('sentryDsn')).toBeUndefined();
    expect(() => config.getOrThrow('sentryDsn')).toThrow(ConfigError);
    expect(() => config.getOrThrow('sentryDsn')).toThrow(
      'Config key "sentryDsn" is not set',
    );
    expect(config.getOrThrow('port')).toBe(3000);
  });
});
