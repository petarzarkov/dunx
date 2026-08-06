import { Logger } from '@dunx/core';
import {
  Gateway,
  HttpStatusCode,
  OnClose,
  OnDrain,
  OnMessage,
  OnOpen,
  OnPing,
  OnPong,
  OnUpgrade,
  type Socket,
} from '@dunx/http';
import type { BunRequest } from 'bun';
import { Lobby } from './lobby.service.js';

/**
 * Served by the same `Bun.serve` call as the HTTP routes: `HttpFactory` discovers
 * it from `providers`, and `listen()` mounts the upgrade as a native route.
 */
@Gateway('/chat')
export class ChatGateway {
  constructor(
    private readonly lobby: Lobby,
    private readonly logger: Logger,
  ) {}

  /**
   * Runs before the socket exists, and is the only place a connection can be
   * refused: return a `Response` and there is no upgrade. Anything else returned
   * becomes `socket.data.context`, which is how a room name or an authenticated
   * user gets carried onto the connection.
   *
   * It is handed the `BunRequest` because the upgrade really is a route - Bun
   * matched it - so headers, query and path params are all readable here.
   */
  @OnUpgrade()
  upgrade(req: BunRequest): Response | { nickname: string } {
    const nickname = new URL(req.url).searchParams.get('as') ?? 'anonymous';
    if (nickname === 'banned') {
      return new Response('nope', { status: HttpStatusCode.FORBIDDEN });
    }
    return { nickname };
  }

  @OnOpen()
  opened(socket: Socket): void {
    // Bun's own pub/sub - topics live in the runtime, not in a JavaScript map.
    socket.subscribe(Lobby.TOPIC);
    socket.send('welcome');
  }

  @OnMessage('say')
  say(text: string): { delivered: number } {
    // The broadcast reaches everyone subscribed; the return value is replied to
    // the sender under the same event name.
    return { delivered: this.lobby.broadcast(text) };
  }

  /**
   * Backpressure relieved: Bun buffered because the client was not reading fast
   * enough and has now flushed. This is where a server streaming to a slow
   * consumer resumes.
   */
  @OnDrain()
  drained(socket: Socket): void {
    this.logger.info(`${socket.data.path} drained, safe to resume sending`);
  }

  /** Bun answers with a pong itself; this is for observing liveness. */
  @OnPing()
  pinged(_data: Buffer, socket: Socket): void {
    this.logger.info(`${socket.data.path} pinged`);
  }

  @OnPong()
  ponged(_data: Buffer, socket: Socket): void {
    this.logger.info(`${socket.data.path} ponged`);
  }

  @OnClose()
  closed(socket: Socket, code: number): void {
    this.logger.info(`${socket.data.path} closed with ${code}`);
  }
}
