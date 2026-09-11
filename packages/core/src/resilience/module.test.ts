import { describe, expect, it } from 'bun:test';
import { AppFactory } from '../di/app.js';
import { inject } from '../di/inject.js';
import { Module } from '../di/module.js';
import { provide } from '../di/provider.js';
import { token } from '../di/token.js';
import { ResilienceOptions } from './options.js';
import { ResiliencePolicy } from './policy.js';
import { ResilienceModule, resiliencePolicy } from './module.js';

describe('ResilienceModule.forRoot', () => {
  it('binds ResiliencePolicy and ResilienceOptions', async () => {
    @Module({ imports: [ResilienceModule.forRoot({ timeoutMs: 250 })] })
    class AppModule {}

    const app = await AppFactory.create(AppModule);

    expect(app.get(ResiliencePolicy)).toBeInstanceOf(ResiliencePolicy);
    expect(app.get(ResilienceOptions).timeoutMs).toBe(250);
    expect(await app.get(ResiliencePolicy).run(() => Promise.resolve(1))).toBe(
      1,
    );
    await app.shutdown();
  });

  it('takes the retry policy and runs it', async () => {
    @Module({
      imports: [
        ResilienceModule.forRoot({
          retry: { maxRetries: 2, retryDelayMs: 1, backoff: { jitterMs: 0 } },
        }),
      ],
    })
    class AppModule {}

    const app = await AppFactory.create(AppModule);
    let calls = 0;
    const result = await app.get(ResiliencePolicy).run(() => {
      calls += 1;
      if (calls < 3) throw new Error('not yet');
      return Promise.resolve('ok');
    });

    expect(result).toBe('ok');
    expect(calls).toBe(3);
    await app.shutdown();
  });

  it('does not claim ResiliencePolicy when named', async () => {
    @Module({ imports: [ResilienceModule.forRoot({ name: 'payment' })] })
    class AppModule {}

    const app = await AppFactory.create(AppModule);
    expect(() => app.get(ResiliencePolicy)).toThrow();
    expect(app.get(resiliencePolicy('payment'))).toBeInstanceOf(
      ResiliencePolicy,
    );
    await app.shutdown();
  });
});

/**
 * Two policies with different budgets need two options tokens: a scope reports a
 * second `ResilienceOptions` as a duplicate binding.
 */
describe('named policies', () => {
  it('returns the same token for the same name', () => {
    expect(resiliencePolicy('payment')).toBe(resiliencePolicy('payment'));
    expect(resiliencePolicy('payment')).not.toBe(resiliencePolicy('search'));
  });

  it('lets two coexist alongside one default', async () => {
    class Callers {
      readonly payment = inject(resiliencePolicy('payment'));
      readonly search = inject(resiliencePolicy('search'));
    }

    @Module({
      imports: [
        ResilienceModule.forRoot({ timeoutMs: 1_000 }),
        ResilienceModule.forRoot({ name: 'payment', timeoutMs: 2_000 }),
        ResilienceModule.forRootAsync(() => ({ timeoutMs: 3_000 }), 'search'),
      ],
      providers: [Callers],
    })
    class AppModule {}

    const app = await AppFactory.create(AppModule);
    const callers = app.get(Callers);

    expect(callers.payment).not.toBe(callers.search);
    expect(app.get(ResiliencePolicy)).not.toBe(callers.payment);
    expect(await callers.search.run(() => Promise.resolve('ok'))).toBe('ok');
    await app.shutdown();
  });
});

describe('a policy registered as a subclass', () => {
  class PaymentPolicy extends ResiliencePolicy {}

  it('resolves as a constructor parameter', async () => {
    class Checkout {
      constructor(readonly policy: PaymentPolicy) {}
    }

    @Module({
      imports: [ResilienceModule.forRoot({ timeoutMs: 3_000 }, PaymentPolicy)],
      providers: [
        // The suite runs without `@dunx/transform`, so the parameter type is not
        // recorded. An app with the preload writes `providers: [Checkout]`.
        provide(Checkout, {
          useFactory: (policy: PaymentPolicy) => new Checkout(policy),
          inject: [PaymentPolicy] as const,
        }),
      ],
    })
    class AppModule {}

    const app = await AppFactory.create(AppModule);
    const checkout = app.get(Checkout);

    expect(checkout.policy).toBeInstanceOf(PaymentPolicy);
    expect(await checkout.policy.run(() => Promise.resolve('ok'))).toBe('ok');
    expect(() => app.get(ResiliencePolicy)).toThrow();
    await app.shutdown();
  });
});

describe('ResilienceModule.forRootAsync', () => {
  it('reads its options off a factory', async () => {
    @Module({
      imports: [
        ResilienceModule.forRootAsync({
          useFactory: () => ({ timeoutMs: 444 }),
        }),
      ],
    })
    class AppModule {}

    const app = await AppFactory.create(AppModule);
    expect(app.get(ResilienceOptions).timeoutMs).toBe(444);
    await app.shutdown();
  });

  /**
   * A dynamic module is its own scope, so a factory injecting a provider needs the
   * module exporting it in *these* imports. Asserted with a `token()`, never a
   * class: an unbound class self-binds into whichever scope asks first, so it would
   * resolve whether or not `imports` reached the factory.
   */
  it('forwards its own imports to the factory', async () => {
    const BUDGET = token<number>('UpstreamBudget');

    @Module({
      providers: [provide(BUDGET, { useValue: 555 })],
      exports: [BUDGET],
    })
    class BudgetModule {}

    @Module({
      imports: [
        ResilienceModule.forRootAsync({
          imports: [BudgetModule],
          useFactory: (timeoutMs: number) => ({ timeoutMs }),
          inject: [BUDGET],
        }),
      ],
    })
    class AppModule {}

    const app = await AppFactory.create(AppModule);
    expect(app.get(ResilienceOptions).timeoutMs).toBe(555);
    await app.shutdown();
  });

  it('forwards those imports to a named policy too', async () => {
    const BUDGET = token<number>('NamedBudget');

    @Module({
      providers: [provide(BUDGET, { useValue: 666 })],
      exports: [BUDGET],
    })
    class BudgetModule {}

    class Caller {
      readonly billing = inject(resiliencePolicy('billing'));
    }

    @Module({
      imports: [
        ResilienceModule.forRootAsync(
          {
            imports: [BudgetModule],
            useFactory: (timeoutMs: number) => ({ timeoutMs }),
            inject: [BUDGET],
          },
          'billing',
        ),
      ],
      providers: [Caller],
    })
    class AppModule {}

    const app = await AppFactory.create(AppModule);
    expect(await app.get(Caller).billing.run(() => Promise.resolve('ok'))).toBe(
      'ok',
    );
    await app.shutdown();
  });

  it('accepts a bare async loader', async () => {
    @Module({
      imports: [
        ResilienceModule.forRootAsync(async () => {
          await Bun.sleep(1);
          return { timeoutMs: 4321 };
        }),
      ],
    })
    class AppModule {}

    const app = await AppFactory.create(AppModule);
    expect(app.get(ResilienceOptions).timeoutMs).toBe(4321);
    await app.shutdown();
  });

  it('registers a subclass from a factory', async () => {
    class SearchPolicy extends ResiliencePolicy {}

    @Module({
      imports: [
        ResilienceModule.forRootAsync(() => ({ timeoutMs: 77 }), SearchPolicy),
      ],
    })
    class AppModule {}

    const app = await AppFactory.create(AppModule);
    expect(app.get(SearchPolicy)).toBeInstanceOf(SearchPolicy);
    await app.shutdown();
  });
});
