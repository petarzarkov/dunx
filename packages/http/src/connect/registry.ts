import {
  createConnectRouter,
  type ConnectRouter,
  type ServiceImpl,
} from '@connectrpc/connect';
import { createFetchHandler } from '@connectrpc/connect/protocol';
import type { DescService } from '@bufbuild/protobuf';
import { PathClaims } from '../route/claims.js';
import { ConnectOptions } from './options.js';

/** What `createFetchHandler` returns: the `Bun.serve` signature exactly. */
export type ConnectHandler = (req: Request) => Promise<Response>;

/** One mounted RPC. */
export interface ConnectMethodInfo {
  /** The path it answers, including {@link ConnectOptions.prefix}. */
  readonly path: string;
  /** e.g. `greet.v1.GreetService`. */
  readonly service: string;
  /** e.g. `Say`. */
  readonly method: string;
  /** `unary`, `server_streaming`, `client_streaming` or `bidi_streaming`. */
  readonly kind: string;
  /** e.g. `['grpc-web', 'connect']`. */
  readonly protocols: readonly string[];
}

/** What the middleware needs per path, in one lookup. */
export interface ConnectRoute {
  readonly handle: ConnectHandler;
  /** Anything but `unary`, so the gap between messages is the protocol. */
  readonly streaming: boolean;
}

/**
 * One fetch handler per RPC, built at boot into a path map, so a request costs a
 * `Map.get`. Connect's own router picks the protocol off the content type.
 *
 * `grpc` is off and cannot be turned on: it carries `grpc-status` in an HTTP
 * trailer and `Bun.serve` sends none, so advertising it would answer with a
 * status no client reads. Probed on Bun 1.4.2.
 */
export class ConnectRegistry {
  readonly #routes = new Map<string, ConnectRoute>();
  /** Every mounted path, in registration order. */
  get paths(): readonly string[] {
    return [...this.#routes.keys()];
  }

  /** Seconds a streaming call may idle; `0` lifts the deadline. */
  readonly streamTimeout: number;
  readonly #methods: ConnectMethodInfo[] = [];
  readonly #stopping = new AbortController();

  constructor(options: ConnectOptions, implementations: readonly object[]) {
    this.streamTimeout = options.streamTimeout;
    const router: ConnectRouter = createConnectRouter({
      ...options.router,
      connect: options.connect,
      grpcWeb: options.grpcWeb,
      grpc: false,
      shutdownSignal: this.#stopping.signal,
    });

    options.services.forEach((registration, index) => {
      const implementation = implementations[index];
      if (implementation === undefined) {
        throw new Error(
          `No instance was resolved for ${registration.useClass.name}, which ` +
            `serves ${registration.service.typeName}.`,
        );
      }
      // `connectService` checked this pairing where both types were known.
      router.service(
        registration.service,
        implementation as ServiceImpl<DescService>,
      );
    });

    // The same policy routes get, from the same class: a second claim on one
    // path is a boot error naming both, never a silent overwrite.
    const claims = new PathClaims(
      'RPC',
      'Register each service once, or give one its own prefix.',
    );

    for (const handler of router.handlers) {
      const path = `${options.prefix}${handler.requestPath}`;
      const rpc = `${handler.service.typeName}.${handler.method.name}`;
      claims.claim(path, rpc);
      this.#routes.set(path, {
        handle: createFetchHandler(handler),
        streaming: handler.method.methodKind !== 'unary',
      });
      this.#methods.push({
        path,
        service: handler.service.typeName,
        method: handler.method.name,
        kind: handler.method.methodKind,
        protocols: handler.protocolNames,
      });
    }
  }

  /** In registration order. */
  get methods(): readonly ConnectMethodInfo[] {
    return this.#methods;
  }

  routeFor(path: string): ConnectRoute | undefined {
    return this.#routes.get(path);
  }

  /**
   * Aborts the signal every in-flight handler holds, so a long-running
   * implementation gets its cue. It does not close an open response stream -
   * the socket closing does. Measured on `@connectrpc/connect` 2.2.0.
   */
  onShutdown(): void {
    this.#stopping.abort();
  }
}
