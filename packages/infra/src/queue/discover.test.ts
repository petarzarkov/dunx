import {
  AppFactory,
  collectModules,
  Module,
  provide,
  token,
  type ModuleRef,
} from '@dunx/core';
import { describe, expect, it } from 'bun:test';
import { JobHandler } from './decorators.js';
import {
  assertNoDuplicateJobs,
  declaresJobHandler,
  describeJob,
  discoverJobs,
  discoverJobsOn,
  type DiscoveredJob,
} from './discover.js';
import { QueueError, QueueErrorCode } from './errors.js';
import { jobMetaOf } from './marker.js';

class Emails {
  readonly seen: string[] = [];

  @JobHandler({ queue: 'emails', name: 'welcome' })
  welcome(): string {
    this.seen.push('welcome');
    return 'welcome';
  }

  @JobHandler({ queue: 'emails', name: 'digest' })
  digest(): string {
    return 'digest';
  }

  untouched(): string {
    return 'untouched';
  }
}

abstract class BaseReports {
  @JobHandler({ queue: 'reports', name: 'nightly' })
  nightly(): string {
    return 'base';
  }
}

class Reports extends BaseReports {
  // Deliberately not re-decorated: the base's marker is what discovery finds, and
  // dispatch must still land here.
  override nightly(): string {
    return 'override';
  }
}

class Plain {
  hello(): string {
    return 'hello';
  }
}

/**
 * The real container, not a stub. `discoverJobs` resolves a token to ask its
 * instance for handlers, and only a real injector gets `useClass` right - the
 * markers are on the class, the instance comes from the token.
 */
const jobsOf = async (root: ModuleRef): Promise<readonly DiscoveredJob[]> => {
  const app = await AppFactory.create(root);
  try {
    return discoverJobs(collectModules(root), app);
  } finally {
    await app.shutdown();
  }
};

// How discovery itself reads a method: off the descriptor, not off the prototype,
// so the reference stays unbound without tripping the linter.
const methodOf = (proto: object, name: string): unknown =>
  Object.getOwnPropertyDescriptor(proto, name)?.value;

describe('job markers', () => {
  it('records queue and name on the method function itself', () => {
    expect(jobMetaOf(methodOf(Emails.prototype, 'welcome'))).toEqual({
      queue: 'emails',
      name: 'welcome',
    });
    expect(jobMetaOf(methodOf(Emails.prototype, 'untouched'))).toBeUndefined();
  });

  it('reports whether a class declares a handler without constructing it', () => {
    expect(declaresJobHandler(Emails)).toBe(true);
    expect(declaresJobHandler(Reports)).toBe(true);
    expect(declaresJobHandler(Plain)).toBe(false);
  });
});

describe('discoverJobsOn', () => {
  it('finds every marked method and binds it to the instance', () => {
    const emails = new Emails();
    const found = discoverJobsOn(emails);

    expect(found.map((job) => job.name).sort()).toEqual(['digest', 'welcome']);
    expect(found.every((job) => job.provider === 'Emails')).toBe(true);

    const welcome = found.find((job) => job.name === 'welcome');
    welcome?.handler({} as never);
    expect(emails.seen).toEqual(['welcome']);
  });

  it('inherits a base class marker and dispatches to the override', () => {
    const found = discoverJobsOn(new Reports());

    expect(found).toHaveLength(1);
    expect(found[0]?.queue).toBe('reports');
    expect(found[0]?.provider).toBe('Reports');
    expect(found[0]?.handler({} as never)).toBe('override');
  });

  it('finds nothing on an undecorated class', () => {
    expect(discoverJobsOn(new Plain())).toEqual([]);
  });
});

describe('assertNoDuplicateJobs', () => {
  const entry = (provider: string, name: string): DiscoveredJob => ({
    queue: 'emails',
    name,
    provider,
    method: name,
    handler: () => undefined,
  });

  it('rejects two handlers claiming one job name', () => {
    const error = (() => {
      try {
        assertNoDuplicateJobs([entry('A', 'welcome'), entry('B', 'welcome')]);
      } catch (thrown) {
        return thrown as QueueError;
      }
      return undefined;
    })();

    expect(error).toBeInstanceOf(QueueError);
    expect(error?.code).toBe(QueueErrorCode.DUPLICATE_HANDLER);
    expect(error?.message).toContain('A.welcome()');
    expect(error?.message).toContain('B.welcome()');
  });

  it('allows the same job name on two different queues', () => {
    expect(
      assertNoDuplicateJobs([
        { ...entry('A', 'welcome'), queue: 'emails' },
        { ...entry('B', 'welcome'), queue: 'sms' },
      ]),
    ).toHaveLength(2);
  });

  it('separates two pairs that differ only in where the split falls', () => {
    // `queue` and `name` are unvalidated strings, so joining them with one
    // separator makes ("a", "b<sep>c") and ("a<sep>b", "c") the same key and
    // one of the two a phantom duplicate. Held with the separator this used to
    // join on, which no argument about the character can rule out.
    const sep = String.fromCharCode(0);
    expect(
      assertNoDuplicateJobs([
        { ...entry('A', `b${sep}c`), queue: 'a' },
        { ...entry('B', 'c'), queue: `a${sep}b` },
      ]),
    ).toHaveLength(2);
  });
});

describe('discoverJobs across modules', () => {
  it('scans providers and controllers, and skips value providers', async () => {
    const settings = token<{ theme: string }>('Settings');

    @Module({
      providers: [Emails, provide(settings, { useValue: { theme: 'dark' } })],
      controllers: [Reports],
    })
    class Root {}

    const found = await jobsOf(Root);

    expect(found.map((job) => `${job.queue}/${job.name}`).sort()).toEqual([
      'emails/digest',
      'emails/welcome',
      'reports/nightly',
    ]);
  });

  /**
   * Two modules bind the same handler class and neither exports it, so a bare
   * `app.get(token)` is ambiguous and throws. Discovery resolves each candidate as
   * its declaring module would, and a call site that drops the module is what this
   * catches: it fails rather than finding two handlers or none.
   */
  it('resolves a handler from the module that declares it', async () => {
    @Module({ providers: [Emails] })
    class Left {}

    @Module({ providers: [Emails] })
    class Right {}

    @Module({ imports: [Left, Right] })
    class Root {}

    const app = await AppFactory.create(Root);
    try {
      expect(() => app.get(Emails)).toThrow('cannot say which you mean');

      const found = discoverJobs(collectModules(Root), app);
      // One scan per class, so the second module's copy is not a duplicate.
      expect(found.map((job) => job.name).sort()).toEqual([
        'digest',
        'welcome',
      ]);

      found.find((job) => job.name === 'welcome')?.handler({} as never);
      expect(app.get(Emails, Left).seen).toEqual(['welcome']);
      expect(app.get(Emails, Right).seen).toEqual([]);
    } finally {
      await app.shutdown();
    }
  });

  it('finds a handler on a class bound through useClass', async () => {
    // The token is not the class - the class is what carries the markers, and the
    // instance the token resolves to is what they bind to.
    const mailer = token<Emails>('Mailer');

    @Module({ providers: [provide(mailer, { useClass: Emails })] })
    class Root {}

    expect(await jobsOf(Root)).toHaveLength(2);
  });

  it('does not scan a factory-provided instance', async () => {
    const built = token<Emails>('BuiltEmails');

    @Module({ providers: [provide(built, { useFactory: () => new Emails() })] })
    class Root {}

    expect(await jobsOf(Root)).toEqual([]);
  });

  it('scans a class declared by two modules only once', async () => {
    @Module({ providers: [Emails] })
    class Shared {}

    @Module({ imports: [Shared, Shared], providers: [] })
    class Root {}

    expect(await jobsOf(Root)).toHaveLength(2);
  });

  it('finds nothing when no provider declares a handler', async () => {
    @Module({ providers: [Plain] })
    class Root {}

    expect(await jobsOf(Root)).toEqual([]);
  });
});

describe('describeJob', () => {
  it('names the id, queue and job', () => {
    expect(describeJob({ id: '7', queueName: 'emails', name: 'welcome' })).toBe(
      '7 emails[welcome]',
    );
  });

  it('stands in for an id bullmq has not assigned yet', () => {
    expect(
      describeJob({ id: undefined, queueName: 'emails', name: 'welcome' }),
    ).toBe('? emails[welcome]');
  });
});
