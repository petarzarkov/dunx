import { AppFactory, collectModules, Module, provide, token } from '@dunx/core';
import { describe, expect, it } from 'bun:test';
import { AmqpHandler } from './decorators.js';
import {
  discoverSubscriptions,
  discoverSubscriptionsOn,
  selectSubscriptions,
} from './discover.js';
import { AmqpError, AmqpErrorCode } from './errors.js';
import { amqpMetaOf } from './marker.js';
import type { AmqpMessage } from './message.js';

const delivery = {} as AmqpMessage;

class Orders {
  @AmqpHandler({ queue: 'orders', exchange: 'shop', routingKey: 'order.*' })
  onOrder(_message: AmqpMessage): string {
    return 'order';
  }

  notAHandler(): string {
    return 'ignored';
  }
}

class Base {
  @AmqpHandler({ queue: 'audit' })
  onAudit(_message: AmqpMessage): string {
    return 'base';
  }
}

/** An undecorated override still receives the delivery, because the handler is
 * bound off the instance rather than off the prototype the marker was found on. */
class Derived extends Base {
  override onAudit(_message: AmqpMessage): string {
    return 'derived';
  }
}

const graph = async (...providers: readonly unknown[]) => {
  @Module({ providers: providers as never })
  class Root {}
  const app = await AppFactory.create(Root);
  return { app, modules: collectModules(Root) };
};

describe('the marker', () => {
  it('sits on the method function, so nothing accumulates at class definition', () => {
    // Read as the discovery does, off the property descriptor, rather than
    // through the prototype - `unbound-method` flags the latter.
    const method = (name: string): unknown =>
      Object.getOwnPropertyDescriptor(Orders.prototype, name)?.value;

    expect(amqpMetaOf(method('onOrder'))?.queue).toBe('orders');
    expect(amqpMetaOf(method('notAHandler'))).toBeUndefined();
    expect(amqpMetaOf('not a function')).toBeUndefined();
  });
});

describe('discovery', () => {
  it('carries every meta field onto the subscription', async () => {
    const { app, modules } = await graph(Orders);
    const [found] = discoverSubscriptions(modules, app);

    expect(found?.queue).toBe('orders');
    expect(found?.exchange).toBe('shop');
    expect(found?.routingKey).toBe('order.*');
    expect(found?.provider).toBe('Orders');
    expect(found?.method).toBe('onOrder');
    expect(found?.handler(delivery)).toBe('order');
    await app.shutdown();
  });

  it('binds an inherited handler to the most derived override', () => {
    const [found] = discoverSubscriptionsOn(new Derived());
    expect(found?.queue).toBe('audit');
    expect(found?.handler(delivery)).toBe('derived');
  });

  it('skips a value provider, which has no prototype chain to read', async () => {
    const { app, modules } = await graph(
      provide(token<Orders>('dunx.test.amqp.value'), {
        useValue: new Orders(),
      }),
    );
    expect(discoverSubscriptions(modules, app)).toEqual([]);
    await app.shutdown();
  });

  /**
   * Two consumers on one queue is how AMQP spreads load between processes, so two
   * in one process splits its own deliveries rather than doubling throughput.
   */
  it('refuses two handlers on one queue, naming both', async () => {
    class Second {
      @AmqpHandler({ queue: 'orders' })
      alsoOrders(_message: AmqpMessage): string {
        return 'second';
      }
    }
    const { app, modules } = await graph(Orders, Second);

    expect(() => discoverSubscriptions(modules, app)).toThrow(
      /Two handlers consume queue "orders".*Orders\.onOrder.*Second\.alsoOrders/s,
    );
    await app.shutdown();
  });
});

describe('selectSubscriptions', () => {
  it('takes every handler when no filter is given', async () => {
    const { app, modules } = await graph(Orders, Derived);
    expect(
      selectSubscriptions(modules, app, undefined).map((f) => f.queue),
    ).toEqual(['orders', 'audit']);
    await app.shutdown();
  });

  it('narrows to the named queues', async () => {
    const { app, modules } = await graph(Orders, Derived);
    expect(
      selectSubscriptions(modules, app, ['audit']).map((f) => f.queue),
    ).toEqual(['audit']);
    await app.shutdown();
  });

  it('refuses a graph with no handler at all', async () => {
    const { app, modules } = await graph();
    try {
      selectSubscriptions(modules, app, undefined);
      expect.unreachable();
    } catch (error) {
      expect((error as AmqpError).code).toBe(AmqpErrorCode.NO_HANDLERS);
      expect((error as AmqpError).message).toContain('@AmqpHandler');
    }
    await app.shutdown();
  });

  it('refuses a filter that matches nothing', async () => {
    const { app, modules } = await graph(Orders);
    expect(() => selectSubscriptions(modules, app, ['absent'])).toThrow(
      /No handler consumes absent/,
    );
    await app.shutdown();
  });

  /**
   * A typo in one name of several would otherwise start a process that quietly
   * serves only the queues that were spelled right.
   */
  it('refuses a filter where only some names match, naming what it found', async () => {
    const { app, modules } = await graph(Orders, Derived);
    expect(() =>
      selectSubscriptions(modules, app, ['orders', 'oders']),
    ).toThrow(/No handler consumes oders\. Found handlers for orders, audit\./);
    await app.shutdown();
  });
});
