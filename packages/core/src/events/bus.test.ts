import { describe, expect, it } from 'bun:test';
import { Quiet } from '../quiet.fixture.js';
import { EventBus } from './bus.js';
import { AppEvent } from './event.js';

class Placed extends AppEvent {
  constructor(readonly id: string) {
    super();
  }
}

class Shipped extends AppEvent {}

const bus = (): { bus: EventBus; logger: Quiet } => {
  const logger = new Quiet();
  return { bus: new EventBus(logger), logger };
};

describe('AppEvent', () => {
  it('takes its dispatch name from the subclass, not from ctor.name', () => {
    expect(new Placed('a').type).not.toBe(new Shipped().type);
    expect(new Placed('a').type).toBe(new Placed('b').type);
    expect(new Placed('a')).toBeInstanceOf(Event);
  });

  it('carries the payload the subclass declared', () => {
    expect(new Placed('order-1').id).toBe('order-1');
  });
});

describe('EventBus.emit', () => {
  it('delivers to every subscriber in registration order', async () => {
    const { bus: eventBus } = bus();
    const seen: string[] = [];
    eventBus.on(Placed, () => seen.push('first'));
    eventBus.on(Placed, () => seen.push('second'));

    const dispatch = await eventBus.emit(new Placed('a'));

    expect(seen).toEqual(['first', 'second']);
    expect(dispatch.handled).toBe(2);
    expect(dispatch.ok).toBe(true);
    expect(dispatch.event).toBe('Placed');
  });

  it('reaches only the subscribers of that event class', async () => {
    const { bus: eventBus } = bus();
    let placed = 0;
    let shipped = 0;
    eventBus.on(Placed, () => {
      placed += 1;
    });
    eventBus.on(Shipped, () => {
      shipped += 1;
    });

    await eventBus.emit(new Placed('a'));

    expect(placed).toBe(1);
    expect(shipped).toBe(0);
  });

  it('awaits an async handler without the handler doing anything', async () => {
    const { bus: eventBus } = bus();
    let done = false;
    eventBus.on(Placed, async () => {
      await Bun.sleep(5);
      done = true;
    });

    const dispatch = await eventBus.emit(new Placed('a'));

    expect(done).toBe(true);
    expect(dispatch.handled).toBe(1);
  });

  it('awaits work a synchronous handler registered with waitUntil', async () => {
    const { bus: eventBus } = bus();
    let done = false;
    eventBus.on(Placed, (event) => {
      event.waitUntil(
        Bun.sleep(5).then(() => {
          done = true;
        }),
      );
    });

    await eventBus.emit(new Placed('a'));

    expect(done).toBe(true);
  });

  it('picks up work registered after the first round has settled', async () => {
    const { bus: eventBus } = bus();
    const order: string[] = [];
    eventBus.on(Placed, async (event) => {
      await Bun.sleep(1);
      order.push('handler');
      event.waitUntil(
        Bun.sleep(1).then(() => {
          order.push('late');
        }),
      );
    });

    await eventBus.emit(new Placed('a'));

    expect(order).toEqual(['handler', 'late']);
  });

  it('resolves with nothing handled when nobody subscribed', async () => {
    const { bus: eventBus } = bus();
    const dispatch = await eventBus.emit(new Placed('a'));

    expect(dispatch.handled).toBe(0);
    expect(dispatch.ok).toBe(true);
  });

  it('awaits an event emitted from inside a handler', async () => {
    const { bus: eventBus } = bus();
    let inner = false;
    eventBus.on(Shipped, async () => {
      await Bun.sleep(5);
      inner = true;
    });
    eventBus.on(Placed, (event) => {
      event.waitUntil(eventBus.emit(new Shipped()));
    });

    const dispatch = await eventBus.emit(new Placed('a'));

    expect(inner).toBe(true);
    expect(dispatch.handled).toBe(1);
  });
});

describe('EventBus failures', () => {
  it('keeps a throwing handler from stopping the ones after it', async () => {
    const { bus: eventBus, logger } = bus();
    const seen: string[] = [];
    eventBus.on(Placed, () => seen.push('first'));
    eventBus.on(
      Placed,
      () => {
        throw new Error('boom');
      },
      { as: 'Exploder.handle' },
    );
    eventBus.on(Placed, () => seen.push('third'));

    const dispatch = await eventBus.emit(new Placed('a'));

    expect(seen).toEqual(['first', 'third']);
    expect(dispatch.handled).toBe(2);
    expect(dispatch.ok).toBe(false);
    expect(dispatch.failures).toHaveLength(1);
    expect(dispatch.failures[0]?.subscriber).toBe('Exploder.handle');
    expect(logger.errors[0]).toBe('Exploder.handle failed handling Placed');
  });

  it('collects a rejected handler promise the same way', async () => {
    const { bus: eventBus } = bus();
    eventBus.on(Placed, async () => {
      await Bun.sleep(1);
      throw new Error('async boom');
    });

    const dispatch = await eventBus.emit(new Placed('a'));

    expect(dispatch.ok).toBe(false);
    expect(String(dispatch.failures[0]?.error)).toContain('async boom');
  });

  it('collects a rejected waitUntil under the waitUntil name', async () => {
    const { bus: eventBus } = bus();
    eventBus.on(Placed, (event) => {
      event.waitUntil(Promise.reject(new Error('late boom')));
    });

    const dispatch = await eventBus.emit(new Placed('a'));

    expect(dispatch.failures).toEqual([
      { subscriber: 'waitUntil', error: expect.any(Error) },
    ]);
    // The handler itself returned, so it still counts as handled.
    expect(dispatch.handled).toBe(1);
  });

  it('throwIfFailed rethrows a single failure as itself', async () => {
    const { bus: eventBus } = bus();
    const thrown = new Error('only one');
    eventBus.on(Placed, () => {
      throw thrown;
    });

    const dispatch = await eventBus.emit(new Placed('a'));

    expect(() => dispatch.throwIfFailed()).toThrow(thrown);
  });

  it('throwIfFailed aggregates several, and does nothing on success', async () => {
    const { bus: eventBus } = bus();
    eventBus.on(Placed, () => {
      throw new Error('one');
    });
    eventBus.on(Placed, () => {
      throw new Error('two');
    });

    const dispatch = await eventBus.emit(new Placed('a'));
    let caught: unknown;
    try {
      dispatch.throwIfFailed();
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(AggregateError);
    expect((caught as AggregateError).errors).toHaveLength(2);
    expect((caught as AggregateError).message).toBe(
      '2 subscribers of Placed failed',
    );
    expect(
      await eventBus.emit(new Shipped()).then((d) => d.throwIfFailed()),
    ).toBeUndefined();
  });
});

describe('EventSubscription', () => {
  it('counts what it handled and what it failed', async () => {
    const { bus: eventBus } = bus();
    const boom = new Error('nope');
    let fail = false;
    const subscription = eventBus.on(Placed, () => {
      if (fail) throw boom;
    });

    await eventBus.emit(new Placed('a'));
    fail = true;
    await eventBus.emit(new Placed('b'));

    expect(subscription.handled).toBe(1);
    expect(subscription.failed).toBe(1);
    expect(subscription.lastError).toBe(boom);
    expect(subscription.event).toBe('Placed');
  });

  it('names the subscription after the handler, or after `as`', () => {
    const { bus: eventBus } = bus();
    const named = (): void => undefined;

    expect(eventBus.on(Placed, named).subscriber).toBe('named');
    expect(eventBus.on(Placed, () => undefined).subscriber).toBe('anonymous');
    expect(eventBus.on(Placed, named, { as: 'Audit.record' }).subscriber).toBe(
      'Audit.record',
    );
  });

  it('stops delivering once unsubscribed', async () => {
    const { bus: eventBus } = bus();
    let calls = 0;
    const subscription = eventBus.on(Placed, () => {
      calls += 1;
    });

    await eventBus.emit(new Placed('a'));
    expect(subscription.active).toBe(true);
    subscription.unsubscribe();
    subscription.unsubscribe();
    await eventBus.emit(new Placed('b'));

    expect(calls).toBe(1);
    expect(subscription.active).toBe(false);
  });

  it('delivers a `once` subscription exactly once, and stops reporting active', async () => {
    const { bus: eventBus } = bus();
    let calls = 0;
    const subscription = eventBus.once(Placed, () => {
      calls += 1;
    });

    expect(subscription.active).toBe(true);
    await eventBus.emit(new Placed('a'));
    await eventBus.emit(new Placed('b'));

    expect(calls).toBe(1);
    expect(subscription.handled).toBe(1);
    // `EventTarget`'s own `once` removes the listener and leaves the controller
    // alone, so this used to report a spent subscription as live forever.
    expect(subscription.active).toBe(false);
  });

  it('marks a throwing `once` subscription inactive too', async () => {
    const { bus: eventBus } = bus();
    const subscription = eventBus.once(Placed, () => {
      throw new Error('boom');
    });

    await eventBus.emit(new Placed('a'));

    expect(subscription.failed).toBe(1);
    expect(subscription.active).toBe(false);
  });

  it('takes a caller signal alongside its own controller', async () => {
    const { bus: eventBus } = bus();
    const controller = new AbortController();
    let calls = 0;
    const subscription = eventBus.on(
      Placed,
      () => {
        calls += 1;
      },
      { signal: controller.signal },
    );

    await eventBus.emit(new Placed('a'));
    controller.abort();
    await eventBus.emit(new Placed('b'));

    expect(calls).toBe(1);
    // The subscription's own controller never aborted; the listener is gone all
    // the same, which is what `AbortSignal.any` buys.
    expect(subscription.active).toBe(true);
  });
});
