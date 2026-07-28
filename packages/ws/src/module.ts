import {
  provide,
  type Ctor,
  type Deps,
  type DynamicModule,
  type Resolved,
} from '@dunx/core';
import { WsSettings, type WsOptions } from './server/options.js';
import { PubSub } from './server/pubsub.js';

export interface WsAsyncOptions<D extends Deps = Deps> {
  /** Declared here rather than in the factory: providers are registered eagerly. */
  readonly gateways?: readonly Ctor<unknown>[];
  readonly inject?: D;
  readonly useFactory: (...deps: Resolved<D>) => WsOptions | Promise<WsOptions>;
}

export class WsModule {
  /** Registers the gateways, `PubSub`, and the options they are built with. */
  static forRoot(options: WsOptions = {}): DynamicModule {
    return {
      module: WsModule,
      providers: [
        PubSub,
        ...(options.gateways ?? []),
        provide(WsSettings, { useValue: options }),
      ],
    };
  }

  /**
   * Same registrations, options from a factory. Resolution is eager and awaits
   * async factories before any constructor runs, so nothing else has to change.
   */
  static forRootAsync<const D extends Deps>(
    options: WsAsyncOptions<D>,
  ): DynamicModule {
    const { gateways = [], inject, useFactory } = options;
    return {
      module: WsModule,
      providers: [
        PubSub,
        ...gateways,
        provide(WsSettings, {
          useFactory: async (...deps: Resolved<D>) => ({
            ...(await useFactory(...deps)),
            gateways,
          }),
          inject: (inject ?? []) as D,
        }),
      ],
    };
  }
}
