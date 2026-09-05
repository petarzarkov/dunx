import http2 from 'node:http2';
import { Logger, Module } from '@dunx/core';
import { HttpFactory } from '@dunx/http';
import { TelemetryGateway } from './telemetry.gateway.js';

/**
 * `node:http2` rather than `fetch`: Bun's client will not speak h2c, so both
 * `protocol: 'http2'` and `'h2'` reject with `HTTP2Unsupported` against a
 * plain-HTTP origin whatever the server offers. See docs/bun-apis.md.
 */
const overHttp2 = (
  origin: string,
  path: string,
): Promise<{ status: number; text: string; alpn: string }> =>
  new Promise((resolve, reject) => {
    const client = http2.connect(origin);
    const timer = setTimeout(() => {
      client.destroy();
      reject(new Error('the HTTP/2 request timed out'));
    }, 4000);
    const fail = (error: Error): void => {
      clearTimeout(timer);
      client.destroy();
      reject(error);
    };
    client.on('error', fail);

    const request = client.request({ ':path': path, ':method': 'GET' });
    let text = '';
    let status = 0;
    request.setEncoding('utf8');
    request.on('response', (headers) => {
      status = Number(headers[':status']);
    });
    request.on('data', (chunk: string) => {
      text += chunk;
    });
    request.on('error', fail);
    request.on('end', () => {
      clearTimeout(timer);
      client.close();
      resolve({ status, text, alpn: client.alpnProtocol ?? 'h2c' });
    });
    request.end();
  });

export class ProtocolsDemo {
  constructor(private readonly logger: Logger) {}

  async demonstrate(url: string): Promise<void> {
    const { logger } = this;
    const origin = new URL(url).origin;

    const [viaH2, viaH1] = await Promise.all([
      overHttp2(origin, '/api/notes'),
      fetch(new URL('api/notes', url)),
    ]);

    logger.info(
      `GET /api/notes over HTTP/2 -> ${viaH2.status}, ${viaH2.text.length} bytes ` +
        `(${viaH2.alpn}, prior knowledge - no TLS, so no ALPN to negotiate with)`,
    );
    logger.info(
      `GET /api/notes over HTTP/1.1 -> ${viaH1.status}, same port, same routes`,
    );
    logger.info(
      'http1: false would refuse the second one with a 505, and every gateway ' +
        'with it - see the split below',
    );

    await this.#binaryFrame(url);
    await this.#splitPorts();
  }

  /**
   * `http1: false` refuses every HTTP/1.x request, and a websocket upgrade is
   * one - so it strands every gateway on that port. Declaring both without
   * `gatewayPort` is a boot error rather than an app that starts and never
   * accepts a socket.
   */
  async #splitPorts(): Promise<void> {
    const { logger } = this;

    @Module({ providers: [TelemetryGateway] })
    class SplitNode {}

    const refused = await HttpFactory.create(SplitNode, {
      http2: true,
      http1: false,
      requestLogging: false,
      bootLogging: false,
    }).then(
      () => null,
      (error: unknown) => (error as Error).message,
    );
    logger.info(`http1: false with a gateway and no gatewayPort -> ${refused}`);

    // The same options plus a port for the upgrades, which is the shape that
    // works: one container, two Bun.serve instances.
    const split = await HttpFactory.create(SplitNode, {
      http2: true,
      http1: false,
      gatewayPort: 0,
      requestLogging: false,
      bootLogging: false,
    });
    try {
      const routes = await split.listen(0);
      logger.info(
        `routes on ${new URL(routes).port} (HTTP/2 only), gateways on ` +
          `${new URL(split.gatewayUrl ?? '').port} (HTTP/1.1) - one container, two servers`,
      );

      const overHttp1 = await fetch(routes);
      logger.info(
        `GET / on the routes port over HTTP/1.1 -> ${overHttp1.status} (505, refused)`,
      );

      const socket = new WebSocket(
        new URL('telemetry', split.gatewayUrl).href.replace('http', 'ws'),
      );
      await new Promise<void>((resolve, reject) => {
        socket.addEventListener('open', () => resolve(), { once: true });
        setTimeout(
          () => reject(new Error('the split socket never opened')),
          2000,
        );
      });
      logger.info('the gateway accepted an upgrade on its own port');
      socket.close();
      await Bun.sleep(20);
    } finally {
      await split.shutdown();
    }
  }

  /** `binaryType: 'blob'` in `main.ts`, against Bun's default `Buffer`. */
  async #binaryFrame(url: string): Promise<void> {
    const socket = new WebSocket(
      new URL('telemetry', url).href.replace('http', 'ws'),
    );
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => resolve(), { once: true });
      setTimeout(() => reject(new Error('the socket never opened')), 2000);
    });

    const reply = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('no frame arrived')),
        2000,
      );
      socket.addEventListener(
        'message',
        (event: MessageEvent) => {
          clearTimeout(timer);
          resolve(String(event.data));
        },
        { once: true },
      );
    });

    socket.send(new Uint8Array([21, 34, 55]));
    this.logger.info(`telemetry <- ${await reply}`);
    socket.close();
    await Bun.sleep(20);
  }
}
