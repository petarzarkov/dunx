import { Badge, Group, Stack, Text } from '@mantine/core';
import { DataTable, EmptyState, Panel, type Column } from '@dunx/ui';
import type { JSX } from 'react';
import type { GatewayNode } from '../api';
import { Dependencies } from './Dependencies';

/**
 * Websocket gateways, read the same way routes are - off the class prototype, with
 * nothing constructed. A gateway's handlers are the part worth a table: `@OnMessage`
 * with an event claims that envelope, and `@OnMessage` with none is the raw
 * catch-all that sees every unrouted frame, which is exactly the distinction that
 * is invisible in the source when three gateways are open at once.
 */
const handlers = (gateway: GatewayNode): JSX.Element => (
  <Group gap={4}>
    {gateway.handlers.map((handler) => (
      <Badge
        key={`${handler.kind}:${handler.event ?? ''}:${handler.method}`}
        size="xs"
        variant="light"
        color={handler.event === null ? 'gray' : 'indigo'}
        title={`${handler.kind} -> ${handler.method}()`}
      >
        {handler.event ?? handler.kind}
      </Badge>
    ))}
  </Group>
);

const columns: readonly Column<GatewayNode>[] = [
  {
    key: 'path',
    header: 'Path',
    render: (gateway) => (
      <Text className="dunx-mono" fw={600}>
        {gateway.path}
      </Text>
    ),
  },
  {
    key: 'name',
    header: 'Gateway',
    render: (gateway) => (
      <Text size="xs" className="dunx-mono">
        {gateway.name}
      </Text>
    ),
  },
  {
    key: 'module',
    header: 'Module',
    render: (gateway) => (
      <Text size="xs" c="dimmed">
        {gateway.module}
      </Text>
    ),
  },
  { key: 'handlers', header: 'Handles', render: handlers },
  {
    key: 'deps',
    header: 'Injects',
    render: (gateway) => <Dependencies dependencies={gateway.dependencies} />,
  },
];

export const Gateways = ({
  gateways,
}: {
  gateways: readonly GatewayNode[];
}): JSX.Element => (
  <Stack gap="md">
    <Panel
      title="Gateways"
      description="Upgrade paths in the same Bun.serve route table as the HTTP routes."
    >
      <DataTable
        columns={columns}
        rows={gateways}
        rowKey={(gateway) => gateway.path}
        empty={
          <EmptyState
            title="No gateways"
            reason="A gateway is a @Gateway()-decorated class listed in a module's providers."
          />
        }
      />
    </Panel>
  </Stack>
);
