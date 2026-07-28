import {
  Gateway,
  OnClose,
  OnMessage,
  OnOpen,
  OnUpgrade,
  PubSub,
  type Socket,
} from '@dunx/ws';
import { Rooms } from './rooms.service.js';

interface Session {
  readonly user: string;
}

/** The upgrade decides who is connected, so every handler can rely on it. */
type ChatSocket = Socket<Session>;

@Gateway('/chat')
export class ChatGateway {
  // No @Injectable, no @Inject, no parameter decorators — @dunx/compiler records
  // these two types and the container resolves them.
  constructor(
    private readonly rooms: Rooms,
    private readonly pubsub: PubSub,
  ) {}

  @OnUpgrade()
  upgrade(req: Request): Session | Response {
    const user = new URL(req.url).searchParams.get('user');
    return user === null
      ? new Response('a ?user= is required', { status: 401 })
      : { user };
  }

  @OnOpen()
  opened(socket: ChatSocket): void {
    socket.send(`welcome ${socket.data.context.user}`);
  }

  @OnMessage('chat.join')
  join(room: string, socket: ChatSocket): { room: string; members: number } {
    // Bun's own pub/sub: the topic lives in the runtime, not in a JS map.
    socket.subscribe(room);
    return { room, members: this.rooms.join(room, socket.data.context.user) };
  }

  @OnMessage('chat.say')
  say(payload: { room: string; text: string }, socket: ChatSocket): void {
    this.pubsub.publishEvent(payload.room, 'chat.said', {
      from: socket.data.context.user,
      text: payload.text,
    });
  }

  /** Every frame no named event claimed. */
  @OnMessage()
  raw(message: string | Buffer): string {
    return `echo:${String(message)}`;
  }

  @OnClose()
  closed(socket: ChatSocket): void {
    this.rooms.leave(socket.data.context.user);
  }
}
