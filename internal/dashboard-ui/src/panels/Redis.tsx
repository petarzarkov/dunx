import { SimpleGrid, Text } from '@mantine/core';
import { EmptyState, Panel, StatCard, StatusDot } from '@dunx/ui';
import type { JSX } from 'react';
import type { RedisAbsent, RedisReport } from '../api';
import { count, duration } from '../format';

/**
 * A curated handful of `INFO` fields, not the blob. `INFO` is roughly two hundred
 * lines; six of them answer "is the broker healthy" and the rest are one
 * `redis-cli INFO` away for anyone who wants them.
 *
 * The hit ratio is computed rather than shown as two counters: `keyspace_hits` and
 * `keyspace_misses` mean nothing apart and one percentage means something.
 */
const ratio = (info: RedisReport['info']): string | undefined => {
  const hits = Number(info['keyspace_hits'] ?? NaN);
  const misses = Number(info['keyspace_misses'] ?? NaN);
  if (Number.isNaN(hits) || Number.isNaN(misses)) return undefined;
  const total = hits + misses;
  if (total === 0) return 'no lookups yet';
  return `${((hits / total) * 100).toFixed(1)}% hit`;
};

export const Redis = ({
  redis,
}: {
  redis: RedisReport | RedisAbsent | undefined;
}): JSX.Element => {
  if (redis === undefined || redis.configured === false) {
    return (
      <Panel title="Redis">
        <EmptyState
          title="No Redis handle"
          reason="Pass `redis` to DashboardModule - RedisConnection from @dunx/infra/redis satisfies it as written."
        />
      </Panel>
    );
  }

  const { info } = redis;
  const uptime = Number(info['uptime_in_seconds'] ?? NaN);

  return (
    <Panel
      title="Redis"
      description={
        info['redis_version'] &&
        `${info['redis_version']} ${info['redis_mode'] ?? ''}`
      }
      actions={
        <StatusDot
          state={
            redis.error !== undefined
              ? 'down'
              : redis.connected
                ? 'up'
                : 'unknown'
          }
          label={
            redis.error !== undefined
              ? 'unreachable'
              : redis.connected
                ? 'connected'
                : 'connecting'
          }
        />
      }
    >
      {redis.error !== undefined && (
        <Text size="sm" c="red">
          {redis.error}
        </Text>
      )}
      <SimpleGrid cols={{ base: 2, sm: 3, lg: 5 }} spacing="xs">
        <StatCard
          label="Ping"
          value={redis.pingMs === undefined ? '-' : `${redis.pingMs}ms`}
        />
        <StatCard
          label="Memory"
          value={info['used_memory_human'] ?? '-'}
          hint={
            info['used_memory_peak_human'] &&
            `peak ${info['used_memory_peak_human']}`
          }
        />
        <StatCard
          label="Clients"
          value={info['connected_clients'] ?? '-'}
          hint={info['blocked_clients'] && `${info['blocked_clients']} blocked`}
        />
        <StatCard
          label="Commands"
          value={
            info['total_commands_processed'] === undefined
              ? '-'
              : count(Number(info['total_commands_processed']))
          }
          hint={ratio(info)}
        />
        <StatCard
          label="Uptime"
          value={Number.isNaN(uptime) ? '-' : duration(uptime * 1000)}
        />
      </SimpleGrid>
    </Panel>
  );
};
