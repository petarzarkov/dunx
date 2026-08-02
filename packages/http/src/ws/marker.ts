// Symbol.for, so two copies of @dunx/http in a tree still agree on the key. The
// marker goes on the method function itself - nothing accumulates at class
// definition time, so there is no ordering dependence and no cross-file leak.
// Same technique as the route marker; see docs/ARCHITECTURE.md,
// "Route discovery".
const HANDLER = Symbol.for('dunx.ws.handler');
const GATEWAY = Symbol.for('dunx.ws.gateway');

export const HandlerKind = Object.freeze({
  UPGRADE: 'upgrade',
  OPEN: 'open',
  MESSAGE: 'message',
  CLOSE: 'close',
  DRAIN: 'drain',
  PING: 'ping',
  PONG: 'pong',
} as const);
export type HandlerKind = (typeof HandlerKind)[keyof typeof HandlerKind];

export interface HandlerMeta {
  readonly kind: HandlerKind;
  /**
   * Only meaningful for a message handler: the envelope event it claims.
   * `undefined` is the raw catch-all that sees every unrouted frame.
   */
  readonly event: string | undefined;
}

interface HandlerMarked {
  readonly [HANDLER]?: HandlerMeta;
}

interface GatewayMarked {
  readonly [GATEWAY]?: string;
}

export const markHandler = (target: object, meta: HandlerMeta): void => {
  Object.defineProperty(target, HANDLER, { value: meta, configurable: true });
};

export const handlerMetaOf = (value: unknown): HandlerMeta | undefined =>
  typeof value === 'function' ? (value as HandlerMarked)[HANDLER] : undefined;

export const markGateway = (target: object, path: string): void => {
  Object.defineProperty(target, GATEWAY, { value: path, configurable: true });
};

// Plain lookup, not Object.hasOwn: a subclass inherits its base's path, so two
// subclasses of one decorated base collide loudly instead of silently sharing
// the root path.
export const gatewayPathOf = (target: object): string =>
  (target as GatewayMarked)[GATEWAY] ?? '/';

/**
 * `@Gateway` is what separates a gateway from every other provider in the same
 * module, so unlike `@Controller` it is required rather than decorative.
 */
export const isGateway = (target: object): boolean =>
  (target as GatewayMarked)[GATEWAY] !== undefined;
