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

/** Served by the same `Bun.serve` call as the HTTP routes: `listen()` mounts the
 * upgrade as a native route. */
@Gateway('/chat')
export class ChatGateway {
  constructor(
    private readonly lobby: Lobby,
    private readonly logger: Logger,
  ) {}

  /**
   * The only place a connection can be refused: return a `Response` and there is
   * no upgrade. Anything else becomes `socket.data.context`. Handed the
   * `BunRequest`, since Bun matched the upgrade as a route.
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
    // Bun's own pub/sub: topics live in the runtime.
    socket.subscribe(Lobby.TOPIC);
    socket.send('welcome');
  }

  @OnMessage('say')
  say(text: string): { delivered: number } {
    // Broadcast reaches every subscriber; the return value replies to the sender.
    return { delivered: this.lobby.broadcast(text) };
  }

  /** Backpressure relieved: where a server streaming to a slow consumer resumes. */
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
