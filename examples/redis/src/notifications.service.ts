import { RedisConnection } from '@dunx/redis';

const CHANNEL = 'dunx:example:events';

export class NotificationsService {
  readonly received: string[] = [];

  constructor(private readonly redis: RedisConnection) {}

  async listen(): Promise<void> {
    await this.redis.subscribe(CHANNEL, (message) => {
      this.received.push(message);
    });
  }

  async announce(message: string): Promise<number> {
    return this.redis.publish(CHANNEL, message);
  }

  async stop(): Promise<void> {
    await this.redis.unsubscribe(CHANNEL);
  }

  /**
   * The point of the second connection: a `Bun.RedisClient` in subscriber mode
   * rejects every data command, so if subscriptions shared this socket, one
   * `listen()` would have broken every `get` and `set` in the process.
   */
  async stillUsableWhileSubscribed(): Promise<boolean> {
    await this.redis.set('dunx:example:probe', 'ok', { ex: 30 });
    return (await this.redis.get('dunx:example:probe')) === 'ok';
  }
}
