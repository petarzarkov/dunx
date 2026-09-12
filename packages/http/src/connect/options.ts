import type { DescService } from '@bufbuild/protobuf';
import type { ConnectRouterOptions, ServiceImpl } from '@connectrpc/connect';
import type { Ctor, ModuleRef } from '@dunx/core';
import { normalizePrefix } from '../route/prefix.js';

/**
 * Everything `createConnectRouter` takes except the protocol switches and
 * `shutdownSignal`, which the container owns. `interceptors`, `contextValues`,
 * `requestGate`, `jsonOptions` and the rest pass through untouched.
 */
export type ConnectRouterSettings = Omit<
  ConnectRouterOptions,
  'connect' | 'grpc' | 'grpcWeb' | 'shutdownSignal'
>;

/** One protobuf service and the class implementing it. */
export interface ConnectServiceRegistration {
  readonly service: DescService;
  readonly useClass: Ctor<object>;
}

/**
 * Pairs a generated `DescService` with the class serving it, checking at compile
 * time that the class has a method per RPC. A generic function rather than an
 * object literal, which would lose the link between the two arguments.
 */
export const connectService = <T extends DescService>(
  service: T,
  useClass: Ctor<ServiceImpl<T>>,
): ConnectServiceRegistration => ({ service, useClass });

export interface ConnectOptionsInit extends ConnectRouterSettings {
  /** The services to serve, each paired with its implementation class. */
  readonly services: readonly ConnectServiceRegistration[];
  /**
   * Modules whose exports the implementation classes may inject. This module is
   * its own scope and the classes are constructed in it, so a provider they need
   * has to be exported by a module named here - importing it alongside does not
   * reach them.
   */
  readonly imports?: readonly ModuleRef[];
  /**
   * Mounted in front of every RPC path, empty by default, which leaves them at
   * `/{package}.{Service}/{Method}`. `setGlobalPrefix` does not move them: that
   * prefixes discovered routes, and these are matched by a middleware.
   */
  readonly prefix?: string;
  /** Connect, which a `curl` POST of JSON also speaks. @default true */
  readonly connect?: boolean;
  /** gRPC-Web, which browsers and `connect-go` speak. @default true */
  readonly grpcWeb?: boolean;
  /**
   * Seconds a **streaming** RPC may idle before `Bun.serve` severs it. `0` lifts
   * the deadline for the whole call, which is the default because a gap between
   * messages is the protocol rather than a symptom.
   *
   * Worth setting on a public mount: `ThrottleGuard` limits the calls, and this
   * limits how long one that is already streaming may idle.
   *
   * @default 0
   */
  readonly streamTimeout?: number;
}

/** A class rather than an interface, so it is a runtime value the transform can
 * record as a constructor parameter type. */
export class ConnectOptions {
  readonly services: readonly ConnectServiceRegistration[];
  readonly prefix: string;
  readonly connect: boolean;
  readonly grpcWeb: boolean;
  readonly streamTimeout: number;
  readonly router: ConnectRouterSettings;

  constructor(init: ConnectOptionsInit) {
    // `imports` is `ConnectModule`'s, not `createConnectRouter`'s.
    const {
      services,
      prefix,
      connect,
      grpcWeb,
      streamTimeout,
      imports: _imports,
      ...router
    } = init;
    this.services = services;
    // `normalizePrefix` answers '/' for an empty prefix; an RPC mount wants
    // '' there, which leaves every path where a stock client looks.
    const mounted = normalizePrefix(prefix ?? '');
    this.prefix = mounted === '/' ? '' : mounted;
    this.connect = connect ?? true;
    this.grpcWeb = grpcWeb ?? true;
    this.streamTimeout = streamTimeout ?? 0;
    if (!Number.isFinite(this.streamTimeout) || this.streamTimeout < 0) {
      throw new Error(
        `ConnectModule streamTimeout must be a non-negative number of seconds, got ${String(streamTimeout)}.`,
      );
    }
    this.router = router;

    if (!this.connect && !this.grpcWeb) {
      throw new Error(
        'ConnectModule needs at least one protocol, and both connect and ' +
          'grpcWeb are false. Native gRPC is not a third option here: it ' +
          'carries grpc-status in an HTTP trailer and Bun.serve sends none.',
      );
    }
    if (services.length === 0) {
      throw new Error(
        'ConnectModule.forRoot was given no services. Pass at least one ' +
          'connectService(Desc, Impl), or drop the module.',
      );
    }
  }
}
