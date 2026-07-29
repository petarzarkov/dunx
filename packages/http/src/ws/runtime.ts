import { AppError } from '@dunx/core';
import type {
  DiscoveredGateway,
  DiscoveredHandler,
  Invoke,
} from './discover.js';
import { HandlerKind } from './marker.js';

/**
 * One gateway reduced to direct references, built once at boot. Dispatch reads
 * these fields and nothing else — no lookup, no metadata, no DI per message.
 */
export interface GatewayRuntime {
  readonly name: string;
  readonly path: string;
  readonly upgrade: Invoke | undefined;
  readonly open: Invoke | undefined;
  readonly close: Invoke | undefined;
  readonly drain: Invoke | undefined;
  readonly ping: Invoke | undefined;
  readonly pong: Invoke | undefined;
  /** The raw `@OnMessage()` catch-all: every frame no named event claimed. */
  readonly raw: Invoke | undefined;
  readonly events: ReadonlyMap<string, Invoke>;
}

/** What two handlers would have to share to be a collision. */
const slotOf = (handler: DiscoveredHandler): string =>
  handler.kind === HandlerKind.MESSAGE && handler.event !== undefined
    ? `message ${JSON.stringify(handler.event)}`
    : handler.kind;

export const buildRuntime = (gateway: DiscoveredGateway): GatewayRuntime => {
  if (gateway.handlers.length === 0) {
    throw new AppError(
      `${gateway.name} is registered as a gateway but declares no handlers. ` +
        'Add an @OnMessage/@OnOpen/... method, or drop the @Gateway decorator.',
    );
  }

  const owners = new Map<string, DiscoveredHandler>();
  const events = new Map<string, Invoke>();

  for (const handler of gateway.handlers) {
    const slot = slotOf(handler);
    const existing = owners.get(slot);
    if (existing) {
      throw new AppError(
        `Handler collision in ${gateway.name}: ${slot} is claimed by ` +
          `${existing.method}() and by ${handler.method}(). One handler per event.`,
      );
    }
    owners.set(slot, handler);
    if (handler.kind === HandlerKind.MESSAGE && handler.event !== undefined) {
      events.set(handler.event, handler.invoke);
    }
  }

  const at = (slot: string): Invoke | undefined => owners.get(slot)?.invoke;

  return {
    name: gateway.name,
    path: gateway.path,
    upgrade: at(HandlerKind.UPGRADE),
    open: at(HandlerKind.OPEN),
    close: at(HandlerKind.CLOSE),
    drain: at(HandlerKind.DRAIN),
    ping: at(HandlerKind.PING),
    pong: at(HandlerKind.PONG),
    raw: at(HandlerKind.MESSAGE),
    events,
  };
};

/**
 * One route per gateway path, so two gateways on one path would mean one of them
 * could never receive a connection. That is a boot error naming both.
 */
export const buildGateways = (
  discovered: readonly DiscoveredGateway[],
): ReadonlyMap<string, GatewayRuntime> => {
  const byPath = new Map<string, GatewayRuntime>();

  for (const gateway of discovered) {
    const existing = byPath.get(gateway.path);
    if (existing) {
      throw new AppError(
        `Gateway path collision: ${gateway.path} is served by ${existing.name} ` +
          `and by ${gateway.name}. One gateway per path.`,
      );
    }
    byPath.set(gateway.path, buildRuntime(gateway));
  }

  return byPath;
};

export const someHandler = (
  gateways: Iterable<GatewayRuntime>,
  pick: (gateway: GatewayRuntime) => Invoke | undefined,
): boolean => {
  for (const gateway of gateways) if (pick(gateway) !== undefined) return true;
  return false;
};
