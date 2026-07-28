import { RedisConnection } from '@dunx/redis';

export interface Entry {
  readonly player: string;
  readonly score: number;
}

const SCORES = 'dunx:example:leaderboard';
const PLAYERS = 'dunx:example:players';

/**
 * Constructor injection with no annotation of any kind — `@dunx/compiler` records
 * that this parameter is a `RedisConnection`, and the container resolves it before
 * calling `new`.
 */
export class LeaderboardService {
  constructor(private readonly redis: RedisConnection) {}

  async reset(): Promise<void> {
    await this.redis.del(SCORES, PLAYERS);
  }

  /** A hash for the scores and a set for who has played, on one connection. */
  async record(entry: Entry): Promise<void> {
    await this.redis.hset(SCORES, { [entry.player]: entry.score });
    await this.redis.sadd(PLAYERS, entry.player);
  }

  async bump(player: string, by: number): Promise<number> {
    return this.redis.hincrby(SCORES, player, by);
  }

  async standings(): Promise<readonly Entry[]> {
    const scores = await this.redis.hgetall(SCORES);
    return Object.entries(scores)
      .map(([player, score]) => ({ player, score: Number(score) }))
      .sort((left, right) => right.score - left.score);
  }

  async players(): Promise<number> {
    return this.redis.scard(PLAYERS);
  }
}
