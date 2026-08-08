import { Anchor, Badge, Group, Text } from '@mantine/core';
import {
  DataTable,
  EmptyState,
  FilterInput,
  MethodBadge,
  Panel,
  type Column,
} from '@dunx/ui';
import { useMemo, useState, type JSX } from 'react';
import type { GatewayNode, Meta, RouteNode } from '../api';

/**
 * The same routes `@dunx/openapi` documents, for the other audience: the explorer
 * answers "what can a client call", this answers "what did this process register".
 * Which is why the columns are the ones a document does not carry - the module that
 * declared it, the guard chain, whether it is hidden from the document at all.
 *
 * The link into the explorer is a **string from the options**, not a dependency.
 * The structural-restatement precedent says a link is free and importing one
 * package into the other is not.
 */
const guardLabel = (route: RouteNode): JSX.Element => {
  if (route.public) {
    return (
      <Badge size="xs" variant="light" color="teal">
        public
      </Badge>
    );
  }
  const parts = [...route.guards, ...(route.roles ?? [])];
  if (parts.length === 0)
    return (
      <Text size="xs" c="dimmed">
        -
      </Text>
    );
  return (
    <Group gap={4}>
      {route.guards.map((guard) => (
        <Badge key={guard} size="xs" variant="light" color="indigo">
          {guard}
        </Badge>
      ))}
      {(route.roles ?? []).map((role) => (
        <Badge key={role} size="xs" variant="outline" color="grape">
          {role}
        </Badge>
      ))}
    </Group>
  );
};

const validates = (route: RouteNode): JSX.Element => {
  const parts = Object.entries(route.validates);
  if (parts.length === 0)
    return (
      <Text size="xs" c="dimmed">
        -
      </Text>
    );
  return (
    <Group gap={4}>
      {parts.map(([input, vendor]) => (
        <Badge
          key={input}
          size="xs"
          variant="light"
          color="gray"
          title={vendor}
        >
          {input}
        </Badge>
      ))}
    </Group>
  );
};

const columns = (meta: Meta): readonly Column<RouteNode>[] => [
  {
    key: 'method',
    header: 'Method',
    width: 96,
    render: (route) => <MethodBadge method={route.method} />,
  },
  {
    key: 'path',
    header: 'Path',
    render: (route) =>
      meta.openApiPath === undefined || route.hidden ? (
        <Text className="dunx-mono" fw={600}>
          {route.path}
        </Text>
      ) : (
        // The explorer groups by tag and opens an operation from the hash it was
        // given, so the deep link is the operation id it already builds.
        <Anchor
          className="dunx-mono"
          fw={600}
          href={`${meta.openApiPath}#${route.method.toLowerCase()}:${route.path}`}
          target="_blank"
          rel="noreferrer"
          title="Open in the API explorer"
        >
          {route.path}
        </Anchor>
      ),
  },
  {
    key: 'handler',
    header: 'Handler',
    render: (route) => (
      <Text size="xs" className="dunx-mono">
        {route.controller}.{route.handler}
      </Text>
    ),
  },
  {
    key: 'module',
    header: 'Module',
    render: (route) => (
      <Text size="xs" c="dimmed">
        {route.module}
      </Text>
    ),
  },
  { key: 'access', header: 'Access', render: guardLabel },
  { key: 'validates', header: 'Validates', render: validates },
  {
    key: 'flags',
    header: '',
    render: (route) =>
      route.hidden ? (
        <Badge size="xs" variant="light" color="orange" title="@ApiHidden()">
          hidden
        </Badge>
      ) : null,
  },
];

const matches = (route: RouteNode, needle: string): boolean =>
  [route.method, route.path, route.controller, route.handler, route.module]
    .join(' ')
    .toLowerCase()
    .includes(needle.toLowerCase());

export const Routes = ({
  routes,
  gateways,
  meta,
}: {
  routes: readonly RouteNode[];
  gateways: readonly GatewayNode[];
  meta: Meta;
}): JSX.Element => {
  const [query, setQuery] = useState('');
  const shown = useMemo(
    () => routes.filter((route) => matches(route, query)),
    [routes, query],
  );

  return (
    <Panel
      title="Routes"
      description={
        `${routes.length} route(s) served by Bun's own router` +
        (gateways.length === 0
          ? ''
          : `, plus ${gateways.length} gateway upgrade path(s)`)
      }
      actions={
        <FilterInput
          value={query}
          onChange={setQuery}
          placeholder="Filter routes"
        />
      }
    >
      <DataTable
        columns={columns(meta)}
        rows={shown}
        rowKey={(route) => `${route.method} ${route.path}`}
        empty={
          <EmptyState
            title={query === '' ? 'No routes' : 'No route matches that filter'}
            reason={
              query === ''
                ? 'This process declared no controllers - which is normal for a worker.'
                : undefined
            }
          />
        }
      />
    </Panel>
  );
};
