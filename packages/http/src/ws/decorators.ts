import { HandlerKind, markGateway, markHandler } from './marker.js';
import type { HandlerMethod } from '@dunx/core';

type GatewayTarget = abstract new (...args: never[]) => object;

export const Gateway =
  (path = '/') =>
  <T extends GatewayTarget>(target: T): T => {
    markGateway(target, path);
    return target;
  };

const lifecycle =
  (kind: HandlerKind) =>
  () =>
  <T extends HandlerMethod>(value: T): T => {
    markHandler(value, { kind, event: undefined });
    return value;
  };

/** Runs before the socket exists. Return a `Response` to refuse the upgrade. */
export const OnUpgrade = lifecycle(HandlerKind.UPGRADE);
export const OnOpen = lifecycle(HandlerKind.OPEN);
export const OnClose = lifecycle(HandlerKind.CLOSE);
export const OnDrain = lifecycle(HandlerKind.DRAIN);
export const OnPing = lifecycle(HandlerKind.PING);
export const OnPong = lifecycle(HandlerKind.PONG);

/**
 * With an event name, the handler is routed the `data` of any
 * `{"event":"<name>","data":...}` frame. With none, it is the raw catch-all and
 * receives every frame no named handler claimed.
 */
export const OnMessage =
  (event?: string) =>
  <T extends HandlerMethod>(value: T): T => {
    markHandler(value, { kind: HandlerKind.MESSAGE, event });
    return value;
  };
