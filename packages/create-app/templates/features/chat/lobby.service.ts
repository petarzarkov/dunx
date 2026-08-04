import { PubSub } from '@dunx/http';

/**
 * A plain service that publishes without holding a socket. `PubSub` is bound by
 * `HttpFactory` around the root module, so nothing has to be imported or
 * registered for this to resolve - listing it in `providers` would be the
 * container's duplicate-binding error.
 */
export class Lobby {
  static readonly TOPIC = 'lobby';

  readonly said: string[] = [];

  constructor(private readonly pubsub: PubSub) {}

  broadcast(text: string): number {
    this.said.push(text);
    return this.pubsub.publishEvent(Lobby.TOPIC, 'said', text);
  }
}
