import { RedisConnection } from '@dunx/redis';

const KEY = 'dunx:example:session';

export class SessionsService {
  constructor(private readonly redis: RedisConnection) {}

  /** `SET` with an options object rather than Bun's positional overloads. */
  async open(id: string, user: string, ttlSeconds: number): Promise<boolean> {
    const created = await this.redis.set(`${KEY}:${id}`, user, {
      ex: ttlSeconds,
      nx: true,
    });
    // null means NX refused it: the session already existed.
    return created !== null;
  }

  async read(id: string): Promise<string | null> {
    return this.redis.get(`${KEY}:${id}`);
  }

  async ttl(id: string): Promise<number> {
    return this.redis.ttl(`${KEY}:${id}`);
  }

  async close(id: string): Promise<string | null> {
    return this.redis.getdel(`${KEY}:${id}`);
  }

  /** Anything without a wrapper is one `send()` away, typed `unknown`. */
  async serverName(): Promise<string> {
    const reply = await this.redis.send('CLIENT', ['GETNAME']);
    return typeof reply === 'string' && reply.length > 0 ? reply : '(unnamed)';
  }
}
