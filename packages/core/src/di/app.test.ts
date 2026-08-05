import { describe, expect, it } from 'bun:test';
import { ConsoleLogger } from '../logger/console.js';
import { Logger } from '../logger/logger.js';
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

/**
 * The graph every test below shares, and it is written the way an app has to be
 * written now: a module states what it exposes.
 *
 * `Database` is declared by `InfraModule` and exported alongside the token it needs,
 * so `UsersModule` can import both. Under the flat container none of these `exports`
 * or `imports` existed and everything saw everything.
 */
const buildApp = (events: string[]) => {
  @Module({
    providers: [provide(EventsToken, { useValue: events }), Database],
    exports: [EventsToken, Database],
  })
  class InfraModule {}

  @Module({
    imports: [InfraModule],
    providers: [UsersService],
    exports: [UsersService],
  })
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

describe('overrides', () => {
  // The mechanism lives here; @dunx/testing's createTestApp is a wrapper over it.
  it('replaces a module binding in place, keyed by token', async () => {
    @Module({ providers: [provide(EventsToken, { useValue: ['real'] })] })
    class RealModule {}

    const app = await AppFactory.create(RealModule, {
      overrides: [provide(EventsToken, { useValue: ['fake'] })],
    });

    expect(app.get(EventsToken)).toEqual(['fake']);
  });

  it('never calls the factory it replaced', async () => {
    let opened = 0;

    @Module({
      providers: [
        provide(EventsToken, {
          useFactory: async (): Promise<string[]> => {
            opened += 1;
            await Promise.resolve();
            throw new Error('opened the real resource');
          },
        }),
      ],
    })
    class RealModule {}

    const app = await AppFactory.create(RealModule, {
      overrides: [provide(EventsToken, { useValue: ['fake'] })],
    });

    expect(opened).toBe(0);
    expect(app.get(EventsToken)).toEqual(['fake']);
  });

  it('replaces a contract core binds by default', async () => {
    @Module({})
    class EmptyModule {}

    const logger = new ConsoleLogger(undefined, 'fatal');
    const app = await AppFactory.create(EmptyModule, {
      overrides: [provide(Logger, { useValue: logger })],
    });

    expect(app.get(Logger)).toBe(logger);
  });

  it('overrides a class no module lists, because it self-binds', async () => {
    class Repo {
      find(): string {
        return 'real';
      }
    }

    @Module({})
    class EmptyModule {}

    // The container resolves this class without anyone binding it, so an
    // override for it is replacing something, not adding it. Refusing this was
    // the container disagreeing with itself about the same class in the same
    // graph - and a collaborator nobody listed is the usual thing to stub.
    const plain = await AppFactory.create(EmptyModule);
    expect(plain.get(Repo).find()).toBe('real');

    const fake = { find: () => 'fake' } as Repo;
    const app = await AppFactory.create(EmptyModule, {
      overrides: [provide(Repo, { useValue: fake })],
    });
    expect(app.get(Repo).find()).toBe('fake');
  });

  it('rejects an override for a token nobody binds', async () => {
    @Module({})
    class EmptyModule {}

    expect(
      await rejectionMessage(
        AppFactory.create(EmptyModule, {
          overrides: [provide(EventsToken, { useValue: [] })],
        }),
      ),
    ).toMatch(
      /^Nothing to override for Events: no module in the graph binds it/,
    );
  });

  /**
   * Two modules binding one token is **legal** now, and was a boot error under the
   * flat container. That is the per-module rebinding module scoping exists to allow,
   * so what an override has to do is replace it in every scope rather than pick one.
   */
  it('replaces an overridden token in every scope that binds it', async () => {
    @Module({
      providers: [provide(EventsToken, { useValue: ['one'] })],
      exports: [EventsToken],
    })
    class OneModule {}

    @Module({
      providers: [provide(EventsToken, { useValue: ['two'] })],
      exports: [EventsToken],
    })
    class TwoModule {}

    class ReadsOne {
      readonly events = inject(EventsToken);
    }
    class ReadsTwo {
      readonly events = inject(EventsToken);
    }

    @Module({
      imports: [OneModule],
      providers: [ReadsOne],
      exports: [ReadsOne],
    })
    class OneConsumer {}

    @Module({
      imports: [TwoModule],
      providers: [ReadsTwo],
      exports: [ReadsTwo],
    })
    class TwoConsumer {}

    @Module({ imports: [OneConsumer, TwoConsumer] })
    class RootModule {}

    const app = await AppFactory.create(RootModule, {
      overrides: [provide(EventsToken, { useValue: ['fake'] })],
    });

    expect(app.get(ReadsOne).events).toEqual(['fake']);
    expect(app.get(ReadsTwo).events).toEqual(['fake']);
  });

  it('gives each module its own instance when both declare the same class', async () => {
    class Counter {}

    @Module({ providers: [Counter], exports: [Counter] })
    class Left {}

    @Module({ providers: [Counter], exports: [Counter] })
    class Right {}

    class UsesLeft {
      readonly counter = inject(Counter);
    }
    class UsesRight {
      readonly counter = inject(Counter);
    }

    @Module({ imports: [Left], providers: [UsesLeft], exports: [UsesLeft] })
    class LeftFeature {}

    @Module({ imports: [Right], providers: [UsesRight], exports: [UsesRight] })
    class RightFeature {}

    @Module({ imports: [LeftFeature, RightFeature] })
    class RootModule {}

    const app = await AppFactory.create(RootModule);
    // The whole point: one class, two declaring modules, two instances.
    expect(app.get(UsesLeft).counter).not.toBe(app.get(UsesRight).counter);
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
