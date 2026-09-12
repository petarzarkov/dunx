import { createClient, type Client } from '@connectrpc/connect';
import {
  createConnectTransport,
  createGrpcWebTransport,
} from '@connectrpc/connect-web';
import { Logger } from '@dunx/core';
import { RequestMetrics } from '@dunx/http';
import { ConnectRegistry } from '@dunx/http/connect';
import { GreetService } from './greet_pb.js';

type GreetClient = Client<typeof GreetService>;

/**
 * Four callers against one port: a Connect client, a gRPC-Web client, plain
 * `fetch`, and a native gRPC client that is refused with an explanation.
 *
 * The clients are `@connectrpc/connect-web`'s, over `fetch`. dunx wraps neither
 * of them: the outbound half of Connect is the library's own one-liner.
 */
export class RpcDemo {
  constructor(
    private readonly logger: Logger,
    private readonly registry: ConnectRegistry,
    private readonly metrics: RequestMetrics,
  ) {}

  async demonstrate(url: string): Promise<void> {
    const connect: GreetClient = createClient(
      GreetService,
      createConnectTransport({ baseUrl: url }),
    );
    const grpcWeb: GreetClient = createClient(
      GreetService,
      createGrpcWebTransport({ baseUrl: url }),
    );

    const said = await connect.say({ name: 'connect' });
    this.logger.info(
      `connect unary -> ${said.text} (greeted ${said.greeted} so far)`,
    );

    const ticks: string[] = [];
    for await (const message of connect.countdown({ name: 'tick', from: 3 })) {
      ticks.push(message.text);
    }
    this.logger.info(`connect server stream -> ${ticks.join(', ')}`);

    const web = await grpcWeb.say({ name: 'grpc-web' });
    this.logger.info(`grpc-web unary -> ${web.text} on the same port`);

    // The Connect protocol is a plain POST, so anything that speaks HTTP can
    // call it without a generated client.
    const curl = await fetch(new URL('greet.v1.GreetService/Say', url), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'curl' }),
    });
    this.logger.info(`plain JSON POST -> ${curl.status} ${await curl.text()}`);

    await this.refusals(url, connect);
    this.counted();
  }

  /** The two answers that are not a successful call. */
  private async refusals(url: string, connect: GreetClient): Promise<void> {
    try {
      await connect.say({ name: '' });
    } catch (error) {
      this.logger.info(
        `a thrown ConnectError arrives as a status -> ${String(error)}`,
      );
    }

    // gRPC carries grpc-status in an HTTP trailer and Bun.serve sends none, so
    // the handler says so rather than answering with a status no client reads.
    const grpc = await fetch(new URL('greet.v1.GreetService/Say', url), {
      method: 'POST',
      headers: { 'content-type': 'application/grpc' },
      body: new Uint8Array([0, 0, 0, 0, 0]),
    });
    const body = (await grpc.json()) as { code: string };
    this.logger.info(
      `native gRPC content-type -> ${grpc.status} ${body.code} ` +
        '(Connect and gRPC-Web only)',
    );
  }

  /** An rpc matches no route, so it answers off the same fallback a 404 does. */
  private counted(): void {
    const mounted = new Set(this.registry.paths);
    const series = this.metrics
      .snapshot()
      .routes.filter((route) => mounted.has(route.route));
    this.logger.info(
      `${series.length} rpc series over ${mounted.size} mounted methods - ` +
        'each is counted under its own path, not in the (unmatched) one',
    );
  }
}
