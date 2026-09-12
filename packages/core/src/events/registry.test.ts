import { describe, expect, it } from 'bun:test';
import { AppFactory } from '../di/app.js';
import { Module, type DynamicModule } from '../di/module.js';
import { provide } from '../di/provider.js';
import { Logger } from '../logger/logger.js';
import { Quiet } from '../quiet.fixture.js';
import { EventBus } from './bus.js';
import { OnEvent } from './decorators.js';
import { AppEvent } from './event.js';
import { EventBusModule } from './module.js';
import { EventRegistry } from './registry.js';

class Placed extends AppEvent {
  constructor(readonly id: string) {
    super();
  }
}

class Shipped extends AppEvent {}

/** Boot noise would otherwise be one subscription line per suite. */
const quiet = (): DynamicModule => ({
  module: class LoggingModule {},
  global: true,
  exports: [Logger],
  providers: [provide(Logger, { useValue: new Quiet() })],
});

describe('EventRegistry discovery', () => {
  it('subscribes an @OnEvent method declared in a provider', async () => {
    class Audit {
      readonly seen: string[] = [];

      @OnEvent(Placed)
      record(event: Placed): void {
        this.seen.push(event.id);
      }
    }

    @Module({ imports: [EventBusModule, quiet()], providers: [Audit] })
    class AppModule {}

    const app = await AppFactory.create(AppModule);
    await app.get(EventBus).emit(new Placed('order-1'));

    expect(app.get(Audit).seen).toEqual(['order-1']);
    expect(app.get(EventRegistry).list()).toHaveLength(1);
    expect(app.get(EventRegistry).list()[0]?.subscriber).toBe('Audit.record');
    await app.shutdown();
  });

  it('reaches a subscriber whose module never imports the publisher', async () => {
    class Orders {
      readonly bus: EventBus;
      constructor(bus: EventBus) {
        this.bus = bus;
      }
      place(id: string): Promise<unknown> {
        return this.bus.emit(new Placed(id));
      }
    }

    class Notifier {
      readonly sent: string[] = [];

      @OnEvent(Placed)
      async notify(event: Placed): Promise<void> {
        await Bun.sleep(1);
        this.sent.push(event.id);
      }
    }

    @Module({
      providers: [
        provide(Orders, {
          useFactory: (bus: EventBus) => new Orders(bus),
          inject: [EventBus] as const,
        }),
      ],
      exports: [Orders],
    })
    class OrdersModule {}

    @Module({ providers: [Notifier], exports: [Notifier] })
    class NotifierModule {}

    @Module({
      imports: [EventBusModule, quiet(), OrdersModule, NotifierModule],
    })
    class AppModule {}

    const app = await AppFactory.create(AppModule);
    // The async handler is awaited by emit, so nothing here sleeps.
    await app.get(Orders).place('order-2');

    expect(app.get(Notifier).sent).toEqual(['order-2']);
    await app.shutdown();
  });

  it('discovers a handler on a controller and one inherited from a base', async () => {
    abstract class Base {
      readonly hits: string[] = [];

      @OnEvent(Placed)
      onPlaced(event: Placed): void {
        this.hits.push(`base:${event.id}`);
      }
    }

    class Feed extends Base {
      @OnEvent(Shipped)
      onShipped(): void {
        this.hits.push('shipped');
      }
    }

    @Module({
      imports: [EventBusModule, quiet()],
      controllers: [Feed],
    })
    class AppModule {}

    const app = await AppFactory.create(AppModule);
    const bus = app.get(EventBus);
    await bus.emit(new Placed('order-3'));
    await bus.emit(new Shipped());

    expect(app.get(Feed).hits).toEqual(['base:order-3', 'shipped']);
    expect(app.get(EventRegistry).subscribersOf(Placed)).toHaveLength(1);
    expect(app.get(EventRegistry).subscribersOf(Shipped)).toHaveLength(1);
    await app.shutdown();
  });

  it('honours once on the decorator', async () => {
    class Warmer {
      calls = 0;

      @OnEvent(Shipped, { once: true })
      warm(): void {
        this.calls += 1;
      }
    }

    @Module({ imports: [EventBusModule, quiet()], providers: [Warmer] })
    class AppModule {}

    const app = await AppFactory.create(AppModule);
    await app.get(EventBus).emit(new Shipped());
    await app.get(EventBus).emit(new Shipped());

    expect(app.get(Warmer).calls).toBe(1);
    await app.shutdown();
  });

  it('resolves a handler from the module that declares it', async () => {
    class Counter {
      readonly seen: string[] = [];

      @OnEvent(Placed)
      count(event: Placed): void {
        this.seen.push(event.id);
      }
    }

    // Two modules bind the same class, neither exports it. `app.get(Counter)`
    // alone would be ambiguous; discovery resolves through each owning scope.
    @Module({ providers: [Counter] })
    class LeftModule {}

    @Module({ providers: [Counter] })
    class RightModule {}

    @Module({ imports: [EventBusModule, quiet(), LeftModule, RightModule] })
    class AppModule {}

    const app = await AppFactory.create(AppModule);
    await app.get(EventBus).emit(new Placed('order-4'));

    // One scan per class, so the second module's copy is not subscribed twice.
    expect(app.get(EventRegistry).list()).toHaveLength(1);
    expect(app.get(Counter, LeftModule).seen).toEqual(['order-4']);
    expect(app.get(Counter, RightModule).seen).toEqual([]);
    await app.shutdown();
  });

  it('lists nothing when no class declares a handler', async () => {
    class PlainService {
      readonly value = 1;
    }
    class PlainController {
      readonly value = 2;
    }

    @Module({
      imports: [EventBusModule, quiet()],
      providers: [PlainService],
      controllers: [PlainController],
    })
    class AppModule {}

    const app = await AppFactory.create(AppModule);

    expect(app.get(EventRegistry).list()).toEqual([]);
    expect(app.get(EventRegistry).subscribersOf(Placed)).toEqual([]);
    await app.shutdown();
  });
});

describe('EventBusModule', () => {
  it('is one bus however many modules import it', async () => {
    @Module({ imports: [EventBusModule] })
    class LeftModule {}

    @Module({ imports: [EventBusModule] })
    class RightModule {}

    @Module({ imports: [quiet(), LeftModule, RightModule] })
    class AppModule {}

    const app = await AppFactory.create(AppModule);

    expect(app.get(EventBus, LeftModule)).toBe(app.get(EventBus, RightModule));
    await app.shutdown();
  });

  it('logs one line naming every handler it subscribed', async () => {
    class Audit {
      @OnEvent(Placed)
      record(): void {
        // recorded by the subscription's own counters
      }
    }

    const logger = new Quiet();
    @Module({
      imports: [
        EventBusModule,
        {
          module: class LoggingModule {},
          global: true,
          exports: [Logger],
          providers: [provide(Logger, { useValue: logger })],
        },
      ],
      providers: [Audit],
    })
    class AppModule {}

    const app = await AppFactory.create(AppModule);

    expect(logger.lines).toContain('Subscribed 1 handler(s)');
    await app.shutdown();
  });
});
