import { describe, expect, it } from 'bun:test';
import { AppFactory, AppRef } from './app.js';
import { AppError } from './errors.js';
import { Module } from './module.js';
import { provide } from './provider.js';
import { token } from './token.js';
import type { OnInit } from './lifecycle.js';

/**
 * `AppRef` is bound globally by `AppFactory.create` and is the escape hatch for a
 * package that has to resolve a token it cannot name at build time. Its whole
 * contract is *when* it is readable, so both sides of that are the test.
 *
 * No constructor parameters in these fixtures: a package's own suite runs from
 * `src` with no `@dunx/transform` preload, so a recorded dependency would not
 * exist and boot would fail naming it. Factories with an explicit `inject` are how
 * these reach the container.
 */
const LABEL = token<string>('label');

describe('AppRef', () => {
  it('throws when read while the container is still resolving', async () => {
    @Module({
      providers: [
        provide(LABEL, {
          useFactory: (ref: AppRef) => ref.current.get(LABEL),
          inject: [AppRef],
        }),
      ],
    })
    class Root {}

    expect(AppFactory.create(Root)).rejects.toThrow(
      /AppRef was read during construction/,
    );
  });

  it('names onInit as the place to read it instead', async () => {
    @Module({
      providers: [
        provide(LABEL, {
          useFactory: (ref: AppRef) => ref.current.get(LABEL),
          inject: [AppRef],
        }),
      ],
    })
    class Root {}

    expect(AppFactory.create(Root)).rejects.toThrow(/Read it in onInit\(\)/);
  });

  it('hands back the app from onInit, which is what it is for', async () => {
    let resolved: string | undefined;

    class Late implements OnInit {
      #ref: AppRef | undefined;

      attach(ref: AppRef): void {
        this.#ref = ref;
      }

      onInit(): void {
        resolved = this.#ref?.current.get(LABEL);
      }
    }

    @Module({
      providers: [
        provide(LABEL, { useValue: 'read late' }),
        provide(Late, {
          useFactory: (ref: AppRef) => {
            const late = new Late();
            late.attach(ref);
            return late;
          },
          inject: [AppRef],
        }),
      ],
    })
    class Root {}

    const app = await AppFactory.create(Root);

    expect(resolved).toBe('read late');
    await app.shutdown();
  });

  it('is the same holder the container filled, resolvable as a token', async () => {
    @Module({ providers: [provide(LABEL, { useValue: 'x' })] })
    class Root {}

    const app = await AppFactory.create(Root);
    const ref = app.get(AppRef);

    expect(ref).toBeInstanceOf(AppRef);
    expect(ref.current).toBe(app);
    expect(ref.current.get(LABEL)).toBe('x');
    await app.shutdown();
  });

  /** A holder nobody attached, so the error is reachable without a container. */
  it('throws an AppError rather than returning undefined', () => {
    expect(() => new AppRef().current).toThrow(AppError);
  });

  it('reads back whatever attach was given', async () => {
    @Module({ providers: [provide(LABEL, { useValue: 'y' })] })
    class Root {}

    const app = await AppFactory.create(Root);
    const ref = new AppRef();
    ref.attach(app);

    expect(ref.current).toBe(app);
    await app.shutdown();
  });
});
