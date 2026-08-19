import { describe, expect, it } from 'bun:test';
import { AppFactory } from './app.js';
import { inject } from './inject.js';
import type { OnDrain, OnShutdown } from './lifecycle.js';
import { Module } from './module.js';
import { provide } from './provider.js';
import { token } from './token.js';

const EventsToken = token<string[]>('Events');

/**
 * The phase `onShutdown` could not express. `@dunx/http` stops the server before
 * tearing providers down, so anything that has to be observable from outside -
 * a readiness probe, a queue consumer telling the broker to stop dispatching -
 * had nowhere to run. `packages/infra/src/queue/worker.ts` says so in prose:
 * "`App` has no hook to register against".
 */
describe('onDrain', () => {
  const withHooks = async (events: string[]) => {
    class Slow implements OnDrain {
      readonly events = inject(EventsToken);

      async onDrain(): Promise<void> {
        this.events.push('slow.drain.start');
        await Bun.sleep(40);
        this.events.push('slow.drain.end');
      }
    }

    class Quick implements OnDrain, OnShutdown {
      readonly events = inject(EventsToken);

      async onDrain(): Promise<void> {
        this.events.push('quick.drain.start');
        await Bun.sleep(40);
        this.events.push('quick.drain.end');
      }

      onShutdown(): void {
        this.events.push('quick.shutdown');
      }
    }

    @Module({
      providers: [provide(EventsToken, { useValue: events }), Slow, Quick],
    })
    class Root {}

    const app = await AppFactory.create(Root);
    // Resolved so both are instantiated: a provider nobody asks for is never
    // constructed and therefore has no hook to run.
    app.get(Slow);
    app.get(Quick);
    return app;
  };

  it('runs every hook before the first onShutdown', async () => {
    const events: string[] = [];
    const app = await withHooks(events);

    await app.shutdown();

    expect(events.indexOf('quick.shutdown')).toBeGreaterThan(
      events.indexOf('slow.drain.end'),
    );
    expect(events.indexOf('quick.shutdown')).toBeGreaterThan(
      events.indexOf('quick.drain.end'),
    );
  });

  it('runs the hooks concurrently rather than in sequence', async () => {
    const events: string[] = [];
    const app = await withHooks(events);

    const started = Bun.nanoseconds();
    await app.drain();
    const elapsedMs = (Bun.nanoseconds() - started) / 1e6;

    // Two 40 ms hooks. Sequential would be ~80 ms; concurrent is bounded by the
    // slower one. The window is wide because a loaded CI box is not a stopwatch.
    expect(elapsedMs).toBeLessThan(75);
    // Both entered before either finished, which is the actual claim.
    expect(events.slice(0, 2).sort()).toEqual([
      'quick.drain.start',
      'slow.drain.start',
    ]);

    await app.shutdown();
  });

  it('drains once, whichever path asks', async () => {
    const events: string[] = [];
    const app = await withHooks(events);

    await Promise.all([app.drain(), app.drain(), app.shutdown()]);
    await app.shutdown();

    expect(events.filter((e) => e === 'slow.drain.start')).toHaveLength(1);
    expect(events.filter((e) => e === 'quick.shutdown')).toHaveLength(1);
  });

  it('drains on shutdown even with nothing interleaving', async () => {
    const events: string[] = [];
    const app = await withHooks(events);

    // No `drain()` call: a queue worker or a seeder has no server to stop, so
    // `shutdown()` is the only call it makes.
    await app.shutdown();

    expect(events).toContain('slow.drain.end');
  });

  it('leaves an app with no drain hooks alone', async () => {
    @Module({ providers: [] })
    class Empty {}

    const app = await AppFactory.create(Empty);
    await app.drain();
    await app.shutdown();
    await app.closed;
  });
});
