import type { RedisProbe } from '../contracts.js';
import { bounded } from './bounded.js';
import type { RedisReport } from './types.js';

/**
 * Whether the broker is up and what it is doing.
 *
 * This survived the move to bull-board while the queue table did not, and the line
 * between them is worth stating: bull-board answers **what is in the queues**, and
 * this answers **whether the thing underneath them is healthy** - which is a
 * question an app with a cache and no queues at all still has. It is one `PING` and
 * one `INFO`, not a Redis client.
 */
const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** The handful of `INFO` fields worth a panel, out of roughly two hundred. */
const INFO_FIELDS = [
  'redis_version',
  'redis_mode',
  'os',
  'uptime_in_seconds',
  'connected_clients',
  'blocked_clients',
  'used_memory_human',
  'used_memory_peak_human',
  'maxmemory_human',
  'keyspace_hits',
  'keyspace_misses',
  'total_commands_processed',
  'rejected_connections',
] as const;

/**
 * `INFO` replies as a text blob of `key:value` lines with `# Section` headers.
 * Parsed here rather than adding a method per field to `RedisProbe`, which is how a
 * structural restatement turns into a client library.
 */
export const parseInfo = (raw: string): Readonly<Record<string, string>> => {
  const wanted = new Set<string>(INFO_FIELDS);
  const out: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    if (line === '' || line.startsWith('#')) continue;
    const colon = line.indexOf(':');
    if (colon < 1) continue;
    const key = line.slice(0, colon);
    if (wanted.has(key)) out[key] = line.slice(colon + 1);
  }
  return out;
};

export const redisReport = async (
  redis: RedisProbe,
  timeoutMs: number,
): Promise<RedisReport> => {
  const started = performance.now();
  const failed = (error: string): RedisReport => ({
    configured: true,
    connected: redis.connected,
    pingMs: undefined,
    info: {},
    error,
  });

  return bounded(
    async () => {
      try {
        await redis.ping();
        const pingMs = Math.round(performance.now() - started);
        const raw = await redis.send('INFO', []);
        return {
          configured: true as const,
          connected: redis.connected,
          pingMs,
          info: typeof raw === 'string' ? parseInfo(raw) : {},
        };
      } catch (error) {
        return failed(message(error));
      }
    },
    timeoutMs,
    // A broker that is merely *slow* never rejects - it waits out the connection
    // timeout, 5 s by default - so the row has to be produced by the clock.
    () => failed(`no answer in ${timeoutMs}ms`),
  );
};
