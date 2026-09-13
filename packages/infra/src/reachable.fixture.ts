import { defaultRedisUrl } from './redis/options.js';

/**
 * Is there a Redis to test against? CI has none, so four suites are conditional on
 * this and skip themselves when it answers false.
 *
 * The probe uses its own short-lived client with retries off, otherwise an
 * unreachable host would sit in the offline queue for the default ten seconds.
 * `connect()` is explicit because with the offline queue disabled there is nothing
 * to hold a lazily issued command during the handshake, so even a healthy server
 * would report itself unreachable.
 */
export const redisReachable = async (
  url: string = defaultRedisUrl(),
): Promise<boolean> => {
  const client = new Bun.RedisClient(url, {
    connectionTimeout: 500,
    autoReconnect: false,
    enableOfflineQueue: false,
    maxRetries: 0,
  });
  try {
    await client.connect();
    await client.ping();
    return true;
  } catch {
    return false;
  } finally {
    client.close();
  }
};
