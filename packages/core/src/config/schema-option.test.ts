import { describe, expect, it } from 'bun:test';
import { AppFactory } from '../di/app.js';
import { Module } from '../di/module.js';
import { ConfigModule, type ConfigModuleOptions } from './module.js';
import type { StandardSchemaV1 } from './schema.js';
import { ConfigError, ConfigService } from './service.js';

interface AppConfig {
  readonly port: number;
  readonly name: string;
}

class AppConfigService extends ConfigService<AppConfig> {}

/**
 * A hand-written Standard Schema, so nothing here depends on a vendor. Zod 4,
 * Valibot and ArkType produce this same `~standard` shape.
 */
const schemaFrom = (
  validate: (
    value: unknown,
  ) => ReturnType<StandardSchemaV1['~standard']['validate']>,
): StandardSchemaV1<unknown, AppConfig> =>
  ({
    '~standard': { version: 1, vendor: 'handwritten', validate },
  }) as StandardSchemaV1<unknown, AppConfig>;

const read = (value: unknown, key: string): string | undefined => {
  const found = (value as Record<string, unknown>)[key];
  return typeof found === 'string' ? found : undefined;
};

const ok = schemaFrom((value) => ({
  value: {
    port: Number(read(value, 'PORT') ?? 3000),
    name: read(value, 'NAME') ?? 'app',
  },
}));

const rejects = schemaFrom(() => ({
  issues: [
    { message: 'must be a number', path: ['PORT'] },
    { message: 'is required', path: [{ key: 'NAME' }] },
    { message: 'the whole thing is wrong' },
  ],
}));

const appWith = async (options: ConfigModuleOptions<AppConfig>) => {
  @Module({ imports: [ConfigModule.forRoot(options)] })
  class Root {}

  return AppFactory.create(Root);
};

describe('ConfigModule with a schema', () => {
  it('validates the source through it, with no wrapper', async () => {
    const app = await appWith({
      schema: ok,
      as: AppConfigService,
      source: { PORT: '8080', NAME: 'from schema' },
    });

    expect(app.get(AppConfigService).get('port')).toBe(8080);
    expect(app.get(AppConfigService).get('name')).toBe('from schema');
    await app.shutdown();
  });

  it('fails boot with every issue and its path', async () => {
    // A vendor's own error is a different shape per library, and boot failing is
    // not the place to learn which one is installed.
    const boot = appWith({
      schema: rejects,
      as: AppConfigService,
      source: {},
    });

    await expect(boot).rejects.toThrow(ConfigError);
    await expect(boot).rejects.toThrow(/PORT: must be a number/);
    // Valibot's `{ key }` path spelling reads the same as zod's bare key.
    await expect(boot).rejects.toThrow(/NAME: is required/);
    // An issue with no path keeps its message and gains no stray separator.
    await expect(boot).rejects.toThrow(/the whole thing is wrong/);
  });

  it('still takes a validate function', async () => {
    const app = await appWith({
      validate: (env) => ({ port: Number(env['PORT']), name: 'from function' }),
      as: AppConfigService,
      source: { PORT: '1234' },
    });

    expect(app.get(AppConfigService).get('name')).toBe('from function');
    await app.shutdown();
  });

  it('awaits an async schema', async () => {
    const slow = schemaFrom(async (value) => {
      await Bun.sleep(1);
      return { value: { port: 1, name: read(value, 'NAME') ?? 'async' } };
    });

    const app = await appWith({
      schema: slow,
      as: AppConfigService,
      source: {},
    });
    expect(app.get(AppConfigService).get('port')).toBe(1);
    await app.shutdown();
  });
});
