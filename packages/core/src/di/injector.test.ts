import { describe, expect, it } from 'bun:test';
import { AppFactory } from './app.js';
import { CircularDependencyError, AppError } from './errors.js';
import { inject } from './inject.js';
import { Module } from './module.js';
import { provide } from './provider.js';
import { token } from './token.js';

const DsnToken = token<string>('Dsn');

const rejection = (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );

const rejectionMessage = async (promise: Promise<unknown>): Promise<string> => {
  const error = await rejection(promise);
  if (!(error instanceof Error))
    throw new Error('expected the promise to reject with an Error');
  return error.message;
};

class Config {
  readonly url = 'db://one';
}

class Logger {
  readonly lines: string[] = [];
  log(line: string): void {
    this.lines.push(line);
  }
}

class UsersService {
  readonly logger = inject(Logger);
  readonly config = inject(Config);

  list(): string[] {
    this.logger.log('list');
    return [this.config.url];
  }
}

describe('inject()', () => {
  it('resolves classes with no token and no manual generics', async () => {
    @Module({ providers: [UsersService, Config] })
    class UsersModule {}

    const app = await AppFactory.create(UsersModule);

    // Annotated on the left on purpose: if get() returned unknown this would not compile.
    const users: UsersService = app.get(UsersService);
    const config: Config = app.get(Config);

    expect(users.list()).toEqual(['db://one']);
    expect(config.url).toBe('db://one');
  });

  it('self-binds an unregistered class - every class is injectable by default', async () => {
    @Module({ providers: [UsersService] })
    class UsersModule {}

    const app = await AppFactory.create(UsersModule);

    app.get(UsersService).list();
    // Neither Logger nor Config appears in any providers array.
    expect(app.get(Logger).lines).toEqual(['list']);
  });

  it('resolves an abstract class as a token, with no token() call', async () => {
    abstract class Clock {
      abstract now(): string;
    }

    class Stamper {
      readonly clock = inject(Clock);
    }

    @Module({
      providers: [
        Stamper,
        provide(Clock, { useFactory: () => ({ now: () => 'noon' }) }),
      ],
    })
    class TimeModule {}

    const app = await AppFactory.create(TimeModule);

    expect(app.get(Stamper).clock.now()).toBe('noon');
  });

  it('throws when called outside construction', () => {
    expect(() => inject(Logger)).toThrow(AppError);
    expect(() => inject(Logger)).toThrow(/outside of construction/);
  });

  it('is unavailable inside a factory - factories declare deps instead', async () => {
    @Module({
      providers: [provide(DsnToken, { useFactory: () => inject(Config).url })],
    })
    class BadModule {}

    expect(await rejectionMessage(AppFactory.create(BadModule))).toMatch(
      /outside of construction/,
    );
  });
});

describe('provide()', () => {
  it('covers useValue, useClass and an async useFactory', async () => {
    @Module({
      providers: [
        provide(Config, { useValue: { url: 'db://async' } }),
        provide(Logger, { useClass: Logger }),
        provide(DsnToken, {
          // `config` is inferred from `inject: [Config]` - no annotation here.
          useFactory: async (config) => {
            await Promise.resolve();
            return `${config.url}/pool`;
          },
          inject: [Config],
        }),
      ],
    })
    class InfraModule {}

    const app = await AppFactory.create(InfraModule);

    expect(app.get(DsnToken)).toBe('db://async/pool');
    expect(app.get(Logger)).toBeInstanceOf(Logger);
  });

  it('lets a synchronous field initializer inject an async factory', async () => {
    class Repository {
      readonly dsn = inject(DsnToken);
    }

    @Module({
      providers: [
        // Listed before the async factory it depends on, so create() must abort
        // Repository's construction, await the factory, and retry.
        Repository,
        provide(DsnToken, {
          useFactory: async (config) => {
            await Promise.resolve();
            return `${config.url}/pool`;
          },
          inject: [Config],
        }),
      ],
    })
    class DataModule {}

    const app = await AppFactory.create(DataModule);

    expect(app.get(Repository).dsn).toBe('db://one/pool');
  });

  it('calls an async factory exactly once even with two dependents', async () => {
    let calls = 0;
    class Left {
      readonly dsn = inject(DsnToken);
    }
    class Right {
      readonly dsn = inject(DsnToken);
    }

    @Module({
      providers: [
        Left,
        Right,
        provide(DsnToken, {
          useFactory: async () => {
            calls += 1;
            await Promise.resolve();
            return 'db://once';
          },
        }),
      ],
    })
    class DataModule {}

    const app = await AppFactory.create(DataModule);

    expect(calls).toBe(1);
    expect(app.get(Left).dsn).toBe('db://once');
    expect(app.get(Right).dsn).toBe(app.get(Left).dsn);
  });

  /**
   * Still an error, and now the *only* duplicate check: the same token twice in one
   * module. Across two modules it is legal, because that is per-module rebinding.
   */
  it('throws when one module binds the same token twice', async () => {
    @Module({
      providers: [
        provide(DsnToken, { useValue: 'a' }),
        provide(DsnToken, { useValue: 'b' }),
      ],
    })
    class TwiceModule {}

    expect(await rejectionMessage(AppFactory.create(TwiceModule))).toMatch(
      /Duplicate binding for Dsn in module "TwiceModule"/,
    );
  });

  it('throws for a token with no binding', async () => {
    class NeedsDsn {
      readonly dsn = inject(DsnToken);
    }

    @Module({ providers: [NeedsDsn] })
    class DataModule {}

    // The message names the consumer and the module, and says what to do - which is
    // the whole reason `exports` is affordable: the error it introduces is a good one.
    const message = await rejectionMessage(AppFactory.create(DataModule));
    expect(message).toMatch(/Cannot resolve Dsn in module "DataModule"/);
    expect(message).toMatch(/Nothing in the module graph declares it/);
  });
});

describe('singleton lifetime', () => {
  it('returns the same instance every time', async () => {
    class Shared {}
    class First {
      readonly shared = inject(Shared);
    }
    class Second {
      readonly shared = inject(Shared);
    }

    @Module({ providers: [Shared, First, Second] })
    class SharedModule {}

    const app = await AppFactory.create(SharedModule);

    expect(app.get(Shared)).toBe(app.get(Shared));
    expect(app.get(First).shared).toBe(app.get(Second).shared);
  });
});

describe('cycle detection', () => {
  it('throws naming the full cycle', async () => {
    class Alpha {
      readonly beta = inject(Beta);
    }
    class Beta {
      readonly alpha = inject(Alpha);
    }

    @Module({ providers: [Alpha, Beta] })
    class CyclicModule {}

    const error = await rejection(AppFactory.create(CyclicModule));

    expect(error).toBeInstanceOf(CircularDependencyError);
    expect((error as CircularDependencyError).cycle).toEqual([
      'Alpha',
      'Beta',
      'Alpha',
    ]);
    expect((error as Error).message).toBe(
      'Circular dependency: Alpha -> Beta -> Alpha',
    );
  });
});
