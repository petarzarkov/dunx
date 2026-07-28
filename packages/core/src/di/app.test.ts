import { describe, expect, it } from 'bun:test';
import { AppFactory } from './app.js';
import { inject } from './inject.js';
import type { OnInit, OnShutdown } from './lifecycle.js';
import {
  collectModules,
  Module,
  readControllers,
  type ModuleClass,
  type ResolvedModule,
} from './module.js';
import { provide } from './provider.js';
import { token } from './token.js';

const EventsToken = token<string[]>('Events');

const rejectionMessage = async (promise: Promise<unknown>): Promise<string> => {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  if (!(error instanceof Error))
    throw new Error('expected the promise to reject with an Error');
  return error.message;
};

const names = (modules: readonly ResolvedModule[]): string[] =>
  modules.map((module) => module.name);

class Database implements OnInit, OnShutdown {
  readonly events = inject(EventsToken);

  onInit(): void {
    this.events.push('database.init');
  }

  async onShutdown(): Promise<void> {
    await Promise.resolve();
    this.events.push('database.shutdown');
  }
}

class UsersService implements OnInit, OnShutdown {
  readonly db = inject(Database);
  readonly events = inject(EventsToken);

  onInit(): void {
    this.events.push('users.init');
  }

  onShutdown(): void {
    this.events.push('users.shutdown');
  }
}

const buildApp = (events: string[]) => {
  @Module({ providers: [provide(EventsToken, { useValue: events })] })
  class InfraModule {}

  @Module({ providers: [UsersService] })
  class UsersModule {}

  @Module({ imports: [InfraModule, UsersModule] })
  class AppModule {}

  return AppFactory.create(AppModule);
};

describe('@Module imports', () => {
  it('composes providers across a root module and its imports', async () => {
    const app = await buildApp([]);

    expect(app.get(UsersService).db).toBe(app.get(Database));
  });

  it('registers imports before their importer', () => {
    @Module({})
    class LeafModule {}

    @Module({ imports: [LeafModule] })
    class MidModule {}

    @Module({ imports: [MidModule] })
    class RootModule {}

    expect(names(collectModules(RootModule))).toEqual([
      'LeafModule',
      'MidModule',
      'RootModule',
    ]);
  });

  it('visits a diamond import once, so the shared binding does not collide', async () => {
    @Module({ providers: [provide(EventsToken, { useValue: ['shared'] })] })
    class SharedModule {}

    @Module({ imports: [SharedModule] })
    class LeftModule {}

    @Module({ imports: [SharedModule] })
    class RightModule {}

    @Module({ imports: [LeftModule, RightModule] })
    class RootModule {}

    expect(names(collectModules(RootModule))).toEqual([
      'SharedModule',
      'LeftModule',
      'RightModule',
      'RootModule',
    ]);
    // Registering SharedModule twice would trip the duplicate-binding check.
    const app = await AppFactory.create(RootModule);
    expect(app.get(EventsToken)).toEqual(['shared']);
  });

  it('terminates on a circular import', () => {
    // A decorator argument cannot reference a class declared below it, so the
    // cycle is closed through the array @Module already captured.
    const firstImports: ModuleClass[] = [];

    @Module({ imports: firstImports })
    class FirstModule {}

    @Module({ imports: [FirstModule] })
    class SecondModule {}

    firstImports.push(SecondModule);

    expect(names(collectModules(FirstModule))).toEqual([
      'SecondModule',
      'FirstModule',
    ]);
  });

  it('registers controllers like providers, and lists them separately', async () => {
    class HealthController {
      readonly ok = true;
    }

    @Module({ controllers: [HealthController] })
    class HealthModule {}

    const app = await AppFactory.create(HealthModule);

    expect(app.get(HealthController).ok).toBe(true);
    // Kept separate so an HTTP adapter knows which instances to scan.
    const [resolved] = collectModules(HealthModule);
    expect(readControllers(resolved!)).toEqual([HealthController]);
  });

  it('rejects an undecorated class anywhere in the graph', async () => {
    class NotAModule {}

    @Module({ imports: [NotAModule] })
    class RootModule {}

    expect(await rejectionMessage(AppFactory.create(RootModule))).toBe(
      'NotAModule is not a dunx module. Decorate it with ' +
        '@Module({ providers: [...] }), or import a configured one from a static ' +
        'factory such as NotAModule.forRoot().',
    );
  });

  it('does not let a subclass inherit its parent module bindings', async () => {
    @Module({ providers: [provide(EventsToken, { useValue: [] })] })
    class ParentModule {}

    class ChildModule extends ParentModule {}

    expect(await rejectionMessage(AppFactory.create(ChildModule))).toMatch(
      /ChildModule is not a dunx module/,
    );
  });
});

describe('lifecycle', () => {
  it('runs onInit in dependency order and onShutdown in reverse', async () => {
    const events: string[] = [];
    const app = await buildApp(events);

    expect(events).toEqual(['database.init', 'users.init']);

    await app.shutdown();
    expect(events).toEqual([
      'database.init',
      'users.init',
      'users.shutdown',
      'database.shutdown',
    ]);
  });

  it('shuts down when a hooked signal fires, and hooks only once', async () => {
    const events: string[] = [];
    const app = await buildApp(events);

    expect(app.enableShutdownHooks(['SIGHUP'])).toBe(app);
    expect(app.enableShutdownHooks(['SIGHUP'])).toBe(app);
    expect(process.listenerCount('SIGHUP')).toBe(1);

    process.emit('SIGHUP');
    await app.closed;

    expect(events).toEqual([
      'database.init',
      'users.init',
      'users.shutdown',
      'database.shutdown',
    ]);
  });

  it('is idempotent for shutdown and resolves closed once', async () => {
    const events: string[] = [];
    const app = await buildApp(events);

    await app.shutdown();
    await app.shutdown();
    await app.closed;

    expect(
      events.filter((event) => event === 'database.shutdown'),
    ).toHaveLength(1);
  });
});
