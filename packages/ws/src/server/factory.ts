import {
  AppFactory,
  type App,
  type InjectionToken,
  type ModuleRef,
  type ShutdownSignal,
} from '@dunx/core';
import type { Server } from 'bun';
import { createWsAdapter, type WsAdapter } from './adapter.js';
import { WsSettings } from './options.js';
import type { SocketData } from './socket.js';

export interface WsApp extends App {
  /** The adapter, for handing `websocket` and `upgrade` to another server. */
  readonly adapter: WsAdapter;
  listen(port?: number): Promise<string>;
}

class WsApplication implements WsApp {
  readonly closed: Promise<void>;
  readonly adapter: WsAdapter;
  readonly #app: App;
  readonly #port: number;
  #server: Server<SocketData> | undefined;
  #resolveClosed: (() => void) | undefined;
  #shuttingDown: Promise<void> | undefined;
  #hooked = false;

  constructor(app: App, adapter: WsAdapter, port: number) {
    this.#app = app;
    this.adapter = adapter;
    this.#port = port;
    this.closed = new Promise<void>((resolve) => {
      this.#resolveClosed = resolve;
    });
  }

  get<T>(token: InjectionToken<T>): T {
    return this.#app.get(token);
  }

  /**
   * The standalone server: one `Bun.serve` whose `fetch` does nothing but hand the
   * request to the adapter. Anything not a gateway path gets the adapter's 404.
   */
  async listen(port = this.#port): Promise<string> {
    const { adapter } = this;
    this.#server = Bun.serve<SocketData>({
      port,
      websocket: adapter.websocket,
      fetch: (req, server) => adapter.upgrade(req, server),
    });
    adapter.attach(this.#server);
    return this.#server.url.href;
  }

  // Not delegated to the core app: the server has to stop before providers tear
  // down, so the signal handler must land here. The stop is forced — a graceful
  // stop waits for open connections, and a WebSocket does not close on its own,
  // so it would hang. Clients see a 1006 close.
  async shutdown(): Promise<void> {
    this.#shuttingDown ??= (async () => {
      await this.#server?.stop(true);
      this.#server = undefined;
      await this.#app.shutdown();
      this.#resolveClosed?.();
    })();
    return this.#shuttingDown;
  }

  enableShutdownHooks(
    signals: readonly ShutdownSignal[] = ['SIGTERM', 'SIGINT'],
  ): this {
    if (this.#hooked) return this;
    this.#hooked = true;
    for (const signal of signals) {
      process.once(signal, () => void this.shutdown());
    }
    return this;
  }
}

export class WsFactory {
  /**
   * Boots the container, discovers every gateway's handlers, detects collisions,
   * and builds the object `Bun.serve` consumes. Nothing is read per message.
   */
  static async create(root: ModuleRef): Promise<WsApp> {
    const app = await AppFactory.create(root);
    const adapter = createWsAdapter(app);
    return new WsApplication(app, adapter, app.get(WsSettings).port ?? 3000);
  }
}
