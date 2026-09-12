import type { Ctor } from '../di/token.js';
import type { AppEvent } from './event.js';

// Symbol.for, so two copies of @dunx/core in one tree still agree on the key. The
// marker goes on the method function itself - nothing accumulates at class
// definition time, so there is no ordering dependence and no cross-file leak.
// Same technique as route, gateway, job and schedule discovery.
const HANDLER = Symbol.for('dunx.event.handler');

export interface EventHandlerMeta {
  /** The event class this method consumes. */
  readonly event: Ctor<AppEvent>;
  /** Unsubscribe after the first delivery. @default false */
  readonly once?: boolean;
}

interface EventMarked {
  readonly [HANDLER]?: EventHandlerMeta;
}

export const markEventHandler = (
  target: object,
  meta: EventHandlerMeta,
): void => {
  Object.defineProperty(target, HANDLER, { value: meta, configurable: true });
};

export const eventHandlerMetaOf = (
  value: unknown,
): EventHandlerMeta | undefined =>
  typeof value === 'function' ? (value as EventMarked)[HANDLER] : undefined;
