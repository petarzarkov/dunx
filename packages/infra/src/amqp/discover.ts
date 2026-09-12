import {
  discoverMarked,
  markedMethods,
  markedMethodsOn,
  type Ctor,
  type DiscoveredMethod,
  type ResolvedModule,
  type ScopedResolver,
} from '@dunx/core';
import { AmqpError, AmqpErrorCode } from './errors.js';
import { amqpMetaOf, type AmqpMeta } from './marker.js';
import type { AmqpMessage } from './message.js';

export type AmqpHandlerFn = (message: AmqpMessage) => unknown;

export interface DiscoveredSubscription extends AmqpMeta {
  /** The declaring class, for error messages and boot logs. */
  readonly provider: string;
  readonly method: string;
  /** Already bound to its instance. */
  readonly handler: AmqpHandlerFn;
}

const asSubscription = ({
  meta,
  ...found
}: DiscoveredMethod<AmqpMeta, AmqpHandlerFn>): DiscoveredSubscription => ({
  // Spread, not a field list, so a field added to `AmqpMeta` reaches the
  // consumer without a second edit here.
  ...meta,
  ...found,
});

/** Every marked method on a constructed provider, most-derived first. */
export const discoverSubscriptionsOn = (
  instance: object,
): readonly DiscoveredSubscription[] =>
  markedMethodsOn<AmqpMeta, AmqpHandlerFn>(instance, amqpMetaOf).map(
    asSubscription,
  );

/** Whether a class declares a handler, without constructing it. */
export const declaresAmqpHandler = (ctor: Ctor<unknown>): boolean =>
  markedMethods(ctor.prototype as object | null, amqpMetaOf).length > 0;

/**
 * **One queue, one handler.** A second consumer on a queue is how AMQP spreads
 * load across processes, so two in one process makes the broker round-robin
 * between them and each sees roughly half the messages. `concurrency` is the
 * knob for throughput, and it is per handler.
 */
export const assertNoDuplicateQueues = (
  subscriptions: readonly DiscoveredSubscription[],
): readonly DiscoveredSubscription[] => {
  const claimed = new Map<string, DiscoveredSubscription>();

  for (const found of subscriptions) {
    const existing = claimed.get(found.queue);
    if (existing) {
      throw new AmqpError(
        AmqpErrorCode.DUPLICATE_HANDLER,
        `Two handlers consume queue "${found.queue}": ` +
          `${existing.provider}.${existing.method}() and ` +
          `${found.provider}.${found.method}(). The broker would split the ` +
          'deliveries between them. Raise `consumer.concurrency` instead.',
      );
    }
    claimed.set(found.queue, found);
  }

  return subscriptions;
};

/**
 * Handlers are declared in `@Module({ providers })` - or on a controller - like
 * any other injectable, and found here by their marker, with no registry to keep
 * in step. A factory- or value-provided instance is not scanned: there is no
 * prototype chain to read until it has been built.
 */
export const discoverSubscriptions = (
  modules: readonly ResolvedModule[],
  container: ScopedResolver,
): readonly DiscoveredSubscription[] =>
  assertNoDuplicateQueues(
    discoverMarked<AmqpMeta, AmqpHandlerFn>(modules, container, amqpMetaOf).map(
      asSubscription,
    ),
  );

/**
 * The handlers this process will consume for, or a boot error explaining why
 * there are none.
 */
export const selectSubscriptions = (
  modules: readonly ResolvedModule[],
  container: ScopedResolver,
  wanted: readonly string[] | undefined,
): readonly DiscoveredSubscription[] => {
  const discovered = discoverSubscriptions(modules, container);
  const chosen = wanted
    ? discovered.filter((found) => wanted.includes(found.queue))
    : discovered;

  if (chosen.length === 0) {
    throw new AmqpError(
      AmqpErrorCode.NO_HANDLERS,
      wanted
        ? `No handler consumes ${wanted.join(', ')}. A process with nothing to ` +
            'do would idle forever, so this is a boot error.'
        : 'No AMQP handlers were found. Decorate a method with @AmqpHandler and ' +
            'declare its class in a module this root imports.',
    );
  }

  // A typo in one name of several would otherwise start a process that quietly
  // serves only the queues that were spelled right.
  const missing = (wanted ?? []).filter(
    (queue) => !chosen.some((found) => found.queue === queue),
  );
  if (missing.length > 0) {
    throw new AmqpError(
      AmqpErrorCode.NO_HANDLERS,
      `No handler consumes ${missing.join(', ')}. Found handlers for ` +
        `${discovered.map((found) => found.queue).join(', ')}.`,
    );
  }

  return chosen;
};
