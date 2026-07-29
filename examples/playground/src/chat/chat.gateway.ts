import { Gateway, OnClose, OnMessage, OnOpen, type Socket } from '@dunx/http';
import { Logger } from '../logger.js';
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

  @OnOpen()
  opened(socket: Socket): void {
    // Bun's own pub/sub — topics live in the runtime, not in a JavaScript map.
    socket.subscribe(Lobby.TOPIC);
    socket.send('welcome');
  }

  @OnMessage('say')
  say(text: string): { delivered: number } {
    // The broadcast reaches everyone subscribed; the return value is replied to
    // the sender under the same event name.
    return { delivered: this.lobby.broadcast(text) };
  }

  @OnClose()
  closed(socket: Socket, code: number): void {
    this.logger.info(`${socket.data.path} closed with ${code}`);
  }
}
