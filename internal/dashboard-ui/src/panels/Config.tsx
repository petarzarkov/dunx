import { Alert, Badge, Text } from '@mantine/core';
import {
  DataTable,
  EmptyState,
  FilterInput,
  JsonBlock,
  Panel,
  type Column,
} from '@dunx/ui';
import { useMemo, useState, type JSX } from 'react';
import type { ConfigEntry } from '../api';

/**
 * Keys and types, and a value only where the app's `reveal` predicate said so.
 *
 * **There is no reveal affordance on this page, and that is the design.**
 * `ConfigService` holds whatever the app's `validate` returned, which includes
 * every secret it has. A deny-list of the usual suspects looks careful and leaks
 * the first key nobody thought of, so the default reveals nothing and the app opts
 * in per key at boot - not whoever reached the page, per click.
 */
const columns: readonly Column<ConfigEntry>[] = [
  {
    key: 'key',
    header: 'Key',
    render: (entry) => (
      <Text className="dunx-mono" fw={600} size="sm">
        {entry.key}
      </Text>
    ),
  },
  {
    key: 'type',
    header: 'Type',
    width: 100,
    render: (entry) => (
      <Badge size="xs" variant="default">
        {entry.type}
      </Badge>
    ),
  },
  {
    key: 'value',
    header: 'Value',
    render: (entry) =>
      'value' in entry ? (
        <JsonBlock value={entry.value} maxHeight={160} />
      ) : (
        <Text size="xs" c="dimmed" fs="italic">
          redacted
        </Text>
      ),
  },
];

export const Config = ({
  config,
}: {
  config: readonly ConfigEntry[] | undefined;
}): JSX.Element => {
  const [query, setQuery] = useState('');
  const shown = useMemo(
    () =>
      (config ?? []).filter((entry) =>
        entry.key.toLowerCase().includes(query.toLowerCase()),
      ),
    [config, query],
  );

  if (config === undefined) {
    return (
      <Panel title="Configuration">
        <EmptyState
          title="No ConfigService is bound"
          reason="This app imported no ConfigModule, which is a different thing from an empty configuration."
        />
      </Panel>
    );
  }

  return (
    <Panel
      title="Configuration"
      description={`${config.length} key(s) from the app's own validate function`}
      actions={
        <FilterInput
          value={query}
          onChange={setQuery}
          placeholder="Filter keys"
        />
      }
    >
      <Alert color="gray" variant="light" p="xs">
        <Text size="xs">
          Values are redacted unless the app’s <code>reveal</code> predicate
          allows the key. There is no control here to show one: redaction is
          decided at boot, not by whoever opened this page.
        </Text>
      </Alert>
      <DataTable
        columns={columns}
        rows={shown}
        rowKey={(entry) => entry.key}
        empty={<EmptyState title="No key matches that filter" />}
      />
    </Panel>
  );
};
