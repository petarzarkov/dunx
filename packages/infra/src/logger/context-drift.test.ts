import { describe, expect, it } from 'bun:test';
import { AsyncRequestContext, RequestContext } from '@dunx/core';
import { ContextStore, RequestScopedContext } from '@arkv/logger';
import type { ContextScope, ContextSource } from '@arkv/logger';

/**
 * `LoggerModule` binds `RequestContext` to a `ContextStore` with no adapter between
 * them - `useFactory: (store) => store` - so the two shapes have to stay
 * interchangeable. Nothing at runtime notices when they stop being: the binding is
 * a plain `provide`, and a missing method surfaces as `undefined is not a function`
 * inside a log call, on whichever line happens to run first.
 *
 * The type-level assertions below are the real guard, and they are checked by
 * `bun run typecheck` rather than by running this file. The runtime assertions
 * cover the other direction: a method arkv renames would still typecheck here if
 * dunx renamed it too, and a name is what the binding actually depends on.
 *
 * Companion to the `LOG_LEVELS` test in `module.test.ts`, which exists because a
 * silent upstream rename once disabled level filtering entirely.
 */

// arkv's store must remain assignable to core's contract: this is the binding.
const _storeSatisfiesContract: RequestContext = new ContextStore();

// And core's own implementation must remain acceptable to arkv's logger. This
// direction was a real type error until `@arkv/logger` 0.10.1: `ContextStore`'s
// private field made the class nominal, so `AsyncRequestContext` was rejected with
// "Property 'asyncLocalStorage' is missing".
const _coreSatisfiesSource: ContextSource = new AsyncRequestContext();

// Both arkv scopes satisfy the wider half of its own contract.
const _storeIsScope: ContextScope = new ContextStore();
const _requestScopedIsScope: ContextScope = new RequestScopedContext();

void [
  _storeSatisfiesContract,
  _coreSatisfiesSource,
  _storeIsScope,
  _requestScopedIsScope,
];

const CONTRACT_METHODS = [
  'getContext',
  'updateContext',
  'runWithContext',
] as const;

describe('the context contract dunx binds to', () => {
  it('keeps every method the binding names, on both sides', () => {
    const store = new ContextStore();
    const core = new AsyncRequestContext();

    for (const method of CONTRACT_METHODS) {
      expect(typeof store[method]).toBe('function');
      expect(typeof core[method]).toBe('function');
    }
  });

  it('behaves the same through either implementation', () => {
    for (const context of [new ContextStore(), new AsyncRequestContext()]) {
      const seen = context.runWithContext({ requestId: 'r1' }, () => {
        context.updateContext({ userId: 'u1' });
        return context.getContext();
      });

      expect(seen['requestId']).toBe('r1');
      expect(seen['userId']).toBe('u1');
      // The scope closes on both.
      expect(context.getContext()['requestId']).toBeUndefined();
    }
  });

  /*
   * `ContextStore` does not implement `peekContext`, and must not start: it is
   * public and subclassable upstream, so a subclass overriding `getContext` would
   * be silently bypassed if the logger read an inherited `peekContext` instead.
   */
  it('leaves peekContext off the store, so an override cannot be bypassed', () => {
    expect('peekContext' in new ContextStore()).toBe(false);
    expect(typeof new RequestScopedContext().peekContext).toBe('function');
  });
});
