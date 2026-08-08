import { Alert, Anchor, Group, SimpleGrid, Stack, Text } from '@mantine/core';
import { EmptyState, Panel, StatCard, StatusDot } from '@dunx/ui';
import type { JSX } from 'react';
import type { Meta, QueuesReport, RuntimeReport, Snapshot } from '../api';
import { bytes, count, duration } from '../format';

/**
 * The answer to "what is this process actually doing", which is the question the
 * whole page exists for: the route table, the container it built, the queues it
 * drains and whether its dependencies are reachable, above the fold.
 */
const unresolved = (snapshot: Snapshot): readonly string[] =>
  snapshot.providers.flatMap((provider) =>
    provider.dependencies
      .filter((dependency) => 'unresolved' in dependency)
      .map(
        (dependency) =>
          `${provider.token}.${(dependency as { unresolved: string }).unresolved}`,
      ),
  );

const Probes = ({ runtime }: { runtime: RuntimeReport }): JSX.Element => (
  <Panel
    title="Dependencies"
    description="A probe that did not answer in time reads unknown, never down."
  >
    {runtime.probes.length === 0 ? (
      <EmptyState
        title="No probes configured"
        reason="Pass `redis` or `probes` to DashboardModule to light this up."
      />
    ) : (
      <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }} spacing="xs">
        {runtime.probes.map((probe) => (
          <Group key={probe.name} justify="space-between" wrap="nowrap">
            <StatusDot state={probe.state} label={probe.name} />
            <Text size="xs" c="dimmed" ta="right">
              {probe.detail ?? `${probe.ms}ms`}
            </Text>
          </Group>
        ))}
      </SimpleGrid>
    )}
  </Panel>
);

export const Overview = ({
  snapshot,
  runtime,
  queues,
  meta,
}: {
  snapshot: Snapshot;
  runtime: RuntimeReport | undefined;
  queues: QueuesReport | undefined;
  meta: Meta;
}): JSX.Element => {
  const broken = unresolved(snapshot);

  return (
    <Stack gap="md">
      {/* A parameter the transform could not resolve is a boot error waiting to
          happen, and reconstructing which provider it belongs to is otherwise a
          grep. It goes first because nothing else on the page matters if the
          container cannot close. */}
      {broken.length > 0 && (
        <Alert color="red" title="Unresolvable constructor parameters">
          <Text size="sm">
            {broken.join(', ')} named nothing at runtime - an interface, a
            primitive, a union or a type-only import. Each is a boot error
            naming that parameter.
          </Text>
        </Alert>
      )}

      <SimpleGrid cols={{ base: 2, sm: 3, lg: 6 }} spacing="xs">
        <StatCard label="Routes" value={count(snapshot.routes.length)} />
        <StatCard label="Gateways" value={count(snapshot.gateways.length)} />
        <StatCard label="Modules" value={count(snapshot.modules.length)} />
        <StatCard label="Providers" value={count(snapshot.providers.length)} />
        {/* A count and a link, never job counts: how many jobs are failing is
            bull-board's question and it answers it better. */}
        <StatCard
          label="Queues"
          value={count(queues?.queues.length ?? 0)}
          hint={
            queues?.unavailable === undefined ? (
              <Anchor href={meta.queuesPath} target="_blank" rel="noreferrer">
                bull-board
              </Anchor>
            ) : (
              'no board'
            )
          }
        />
      </SimpleGrid>

      <Panel
        title="Process"
        description="Uptime is measured from when the dashboard was constructed, not from when Bun started."
      >
        {runtime === undefined ? (
          <EmptyState title="Waiting for the first runtime poll" />
        ) : (
          <SimpleGrid cols={{ base: 2, sm: 3, lg: 6 }} spacing="xs">
            <StatCard label="Uptime" value={duration(runtime.uptimeMs)} />
            <StatCard label="Bun" value={runtime.bun} />
            <StatCard label="PID" value={runtime.pid} />
            <StatCard
              label="Heap"
              value={bytes(runtime.memory.heapUsed)}
              hint={`of ${bytes(runtime.memory.heapTotal)}`}
            />
            <StatCard label="RSS" value={bytes(runtime.memory.rss)} />
            <StatCard
              label="Platform"
              value={`${runtime.platform}/${runtime.arch}`}
            />
          </SimpleGrid>
        )}
      </Panel>

      {runtime !== undefined && <Probes runtime={runtime} />}
    </Stack>
  );
};
