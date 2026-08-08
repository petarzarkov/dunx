import { Badge, Group, SimpleGrid, Stack, Text } from '@mantine/core';
import {
  DataTable,
  EmptyState,
  FilterInput,
  Panel,
  type Column,
} from '@dunx/ui';
import { useMemo, useState, type JSX } from 'react';
import type { ModuleNode, ProviderNode } from '../api';
import { Dependencies } from './Dependencies';

/**
 * The panel that earns its place fastest.
 *
 * A missing-binding error names one token; reconstructing which module bound what,
 * what that module exports, and why the graph did not close is otherwise a grep
 * across every `@Module`. This is that graph, already computed by the container,
 * on a page.
 *
 * A nested list rather than a force-directed diagram, and that is the trade the
 * no-layout-engine decision buys. `exported` is the field that answers "why can't X
 * see Y", so it is a column rather than a detail.
 */
const ROLE_COLOR: Readonly<Record<string, string>> = {
  controller: 'blue',
  gateway: 'violet',
  provider: 'gray',
};

const providerColumns: readonly Column<ProviderNode>[] = [
  {
    key: 'token',
    header: 'Token',
    render: (provider) => (
      <Group gap={6} wrap="nowrap">
        <Text className="dunx-mono" fw={600} size="sm">
          {provider.token}
        </Text>
        {provider.class !== undefined && provider.class !== provider.token && (
          <Text size="xs" c="dimmed" className="dunx-mono">
            → {provider.class}
          </Text>
        )}
      </Group>
    ),
  },
  {
    key: 'role',
    header: 'Role',
    width: 110,
    render: (provider) => (
      <Badge
        size="xs"
        variant="light"
        color={ROLE_COLOR[provider.role] ?? 'gray'}
      >
        {provider.role}
      </Badge>
    ),
  },
  {
    key: 'kind',
    header: 'Bound as',
    width: 90,
    render: (provider) => (
      <Text size="xs" c="dimmed">
        {provider.kind}
      </Text>
    ),
  },
  {
    key: 'module',
    header: 'Module',
    render: (provider) => (
      <Text size="xs" c="dimmed">
        {provider.module}
      </Text>
    ),
  },
  {
    key: 'exported',
    header: 'Exported',
    width: 90,
    render: (provider) =>
      provider.exported ? (
        <Badge size="xs" variant="light" color="teal">
          yes
        </Badge>
      ) : (
        <Text
          size="xs"
          c="dimmed"
          title="Private to its module - that is the boundary, not a bug"
        >
          private
        </Text>
      ),
  },
  {
    key: 'deps',
    header: 'Injects',
    render: (provider) => <Dependencies dependencies={provider.dependencies} />,
  },
];

const List = ({
  label,
  items,
  color,
}: {
  label: string;
  items: readonly string[];
  color: string;
}): JSX.Element | null =>
  items.length === 0 ? null : (
    <Group gap={4} align="baseline">
      <Text size="xs" c="dimmed" w={80} style={{ flexShrink: 0 }}>
        {label}
      </Text>
      <Group gap={4}>
        {items.map((item) => (
          <Badge key={item} size="xs" variant="light" color={color}>
            {item}
          </Badge>
        ))}
      </Group>
    </Group>
  );

const ModuleCard = ({ module }: { module: ModuleNode }): JSX.Element => (
  <Panel
    title={
      <Group gap={6}>
        <Text fw={600}>{module.name}</Text>
        {module.global && (
          <Badge
            size="xs"
            color="orange"
            variant="light"
            title="Its exports are visible everywhere with no import"
          >
            global
          </Badge>
        )}
      </Group>
    }
  >
    <Stack gap={4}>
      <List label="imports" items={module.imports} color="gray" />
      <List label="exports" items={module.exports} color="teal" />
      <List label="controllers" items={module.controllers} color="blue" />
      <List label="gateways" items={module.gateways} color="violet" />
      <List label="providers" items={module.providers} color="gray" />
      <List label="middleware" items={module.middleware} color="indigo" />
      {module.exports.length === 0 && (
        <Text size="xs" c="dimmed">
          Exports nothing, so every provider here is private to it.
        </Text>
      )}
    </Stack>
  </Panel>
);

const matches = (provider: ProviderNode, needle: string): boolean =>
  [provider.token, provider.class ?? '', provider.module, provider.role]
    .join(' ')
    .toLowerCase()
    .includes(needle.toLowerCase());

export const Graph = ({
  modules,
  providers,
}: {
  modules: readonly ModuleNode[];
  providers: readonly ProviderNode[];
}): JSX.Element => {
  const [query, setQuery] = useState('');
  const shown = useMemo(
    () => providers.filter((provider) => matches(provider, query)),
    [providers, query],
  );

  return (
    <Stack gap="md">
      <Panel
        title="Providers"
        description="Every binding in the container, which module declared it, and what it injects."
        actions={
          <FilterInput
            value={query}
            onChange={setQuery}
            placeholder="Filter providers"
          />
        }
      >
        <DataTable
          columns={providerColumns}
          rows={shown}
          rowKey={(provider, index) =>
            `${provider.module}:${provider.token}:${index}`
          }
          empty={<EmptyState title="No provider matches that filter" />}
        />
      </Panel>

      <Stack gap="xs">
        <Text size="xs" c="dimmed" tt="uppercase" fw={700}>
          Modules, in traversal order
        </Text>
        <SimpleGrid cols={{ base: 1, lg: 2 }} spacing="sm">
          {modules.map((module) => (
            <ModuleCard key={module.name} module={module} />
          ))}
        </SimpleGrid>
      </Stack>
    </Stack>
  );
};
