import {
  HttpOptionsProvider,
  WsRelay,
  type CorsOptions,
  type PubSubRelay,
  type RequestLoggingOptions,
} from '@dunx/http';
import { AppConfigService, RELAY_CHANNEL } from '../config.js';

/**
 * The HTTP settings that come from validated config, answered from the container
 * rather than computed before it exists.
 *
 * `main.ts` used to open with `const log = validate(Bun.env).log`, because
 * `HttpFactory.create(root, options)` builds the container and so its argument
 * has to be ready first. That was a second call to `validate` on a second copy of
 * the environment, invisible to `ConfigModule`. This class injects
 * `AppConfigService` like anything else.
 *
 * What stays an argument to `create()`: `websocket`, `relay` and `relayChannel`,
 * which are constructed objects rather than settings read from the environment.
 */
export class AppHttpOptions extends HttpOptionsProvider {
  constructor(
    private readonly config: AppConfigService,
    // The contract, not `RedisRelay`, so the backend changes without this moving.
    private readonly bus: WsRelay,
  ) {
    super();
    this.trustProxy = this.config.get('trustProxy');
  }

  /**
   * A field on the base, so a field here (TS2611 rejects an accessor), assigned in
   * the constructor, which is how a field derives from config. Defaults to
   * **false**: believing `x-forwarded-for` with no proxy stripping it lets any
   * caller pick its own address, faking the throttle subject and the logged one.
   */
  override readonly trustProxy: boolean;

  override get prefix(): string {
    return 'api';
  }

  override get cors(): CorsOptions {
    return {
      origin: this.config.get('corsOrigin'),
      credentials: true,
      exposedHeaders: ['x-handled-by'],
      maxAge: 600,
    };
  }

  /** Multi-node websocket fan-out, resolved rather than constructed. */
  override get relay(): PubSubRelay {
    return this.bus;
  }

  override readonly relayChannel = RELAY_CHANNEL;

  override get requestLogging(): RequestLoggingOptions {
    const log = this.config.get('log');
    return {
      // Off by default: both cost a `req.clone().text()` on the hot path.
      requestBody: log.requestBody,
      responseBody: log.responseBody,
      // The dashboard polls every five seconds and would bury everything else.
      ignorePrefix: ['/api/_dunx'],
      // ~360 ns per request, so off by default. On here so `traceId` joins
      // `requestId` and `@dunx/http/client` forwards it upstream.
      trace: true,
    };
  }
}
