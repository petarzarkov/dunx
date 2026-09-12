import {
  createConnectRouter,
  type ConnectRouter,
  type ServiceImpl,
} from '@connectrpc/connect';
import { createFetchHandler } from '@connectrpc/connect/protocol';
import type { DescService } from '@bufbuild/protobuf';
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

/**
 * One fetch handler per RPC, built at boot into a path map, so a request costs a
 * `Map.get`. Connect's own router picks the protocol off the content type.
 *
 * `grpc` is off and cannot be turned on: it carries `grpc-status` in an HTTP
 * trailer and `Bun.serve` sends none, so advertising it would answer with a
 * status no client reads. Probed on Bun 1.4.2.
 */
export class ConnectRegistry {
  readonly #routes = new Map<string, ConnectHandler>();
  readonly #methods: ConnectMethodInfo[] = [];
  readonly #stopping = new AbortController();

  constructor(options: ConnectOptions, implementations: readonly object[]) {
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

    for (const handler of router.handlers) {
      const path = `${options.prefix}${handler.requestPath}`;
      this.#routes.set(path, createFetchHandler(handler));
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

  handlerFor(path: string): ConnectHandler | undefined {
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
