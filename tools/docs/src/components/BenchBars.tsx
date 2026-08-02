import { Badge, Group, Table, Text } from '@mantine/core';
import {
  decimal,
  FOCUS,
  integer,
  type StartupRow,
  type ThroughputRow,
} from '../bench';
import type { BenchRuntime } from '../../scripts/extract/model';

/**
 * The bars are plain divs with a percentage width, not a charting library.
 * Four horizontal bar charts do not justify the dependency, and a `<div>` sized
 * by the same number the adjacent cell prints cannot drift from it.
 */
const Bar = ({
  fraction,
  runtime,
}: {
  fraction: number;
  runtime: BenchRuntime;
}): React.JSX.Element => (
  <div className="bench-track">
    <div
      className="bench-fill"
      data-runtime={runtime}
      style={{ width: `${Math.max(0, Math.min(100, fraction))}%` }}
    />
  </div>
);

export const RuntimeLegend = (): React.JSX.Element => (
  <Group gap="lg">
    <Group gap={6}>
      <span className="bench-swatch" data-runtime="bun" />
      <Text size="xs" c="dimmed">
        Bun
      </Text>
    </Group>
    <Group gap={6}>
      <span className="bench-swatch" data-runtime="node" />
      <Text size="xs" c="dimmed">
        Node
      </Text>
    </Group>
    <Group gap={6}>
      <span className="bench-swatch bench-swatch-focus" />
      <Text size="xs" c="dimmed">
        @dunx/http
      </Text>
    </Group>
  </Group>
);

const rowClass = (id: string): string =>
  id === FOCUS ? 'bench-row-focus' : '';

export const ThroughputTable = ({
  rows,
}: {
  rows: readonly ThroughputRow[];
}): React.JSX.Element => (
  <Table.ScrollContainer minWidth={760}>
    <Table verticalSpacing="xs" fz="sm" highlightOnHover>
      <Table.Thead>
        <Table.Tr>
          <Table.Th w={170}>Subject</Table.Th>
          <Table.Th>Throughput vs raw Bun.serve</Table.Th>
          <Table.Th ta="right" w={100}>
            req/s
          </Table.Th>
          <Table.Th ta="right" w={90}>
            ± stddev
          </Table.Th>
          <Table.Th ta="right" w={80}>
            p50 ms
          </Table.Th>
          <Table.Th ta="right" w={80}>
            p99 ms
          </Table.Th>
        </Table.Tr>
      </Table.Thead>
      <Table.Tbody>
        {rows.map((row) => (
          <Table.Tr key={row.id} className={rowClass(row.id)}>
            <Table.Td>
              <Text
                size="sm"
                ff="monospace"
                fw={row.id === FOCUS ? 700 : 400}
                component="span"
              >
                {row.label}
              </Text>
              {row.bad > 0 && (
                <Badge color="red" size="xs" ml={6}>
                  {row.bad} bad
                </Badge>
              )}
            </Table.Td>
            <Table.Td>
              <Group gap="sm" wrap="nowrap">
                <Bar fraction={row.pctOfBaseline} runtime={row.runtime} />
                <Text size="xs" c="dimmed" w={52} ta="right">
                  {decimal(row.pctOfBaseline, 1)}%
                </Text>
              </Group>
            </Table.Td>
            <Table.Td ta="right" fw={row.id === FOCUS ? 700 : 400}>
              {integer(row.rps)}
            </Table.Td>
            <Table.Td ta="right" c="dimmed">
              {integer(row.stddev)}
            </Table.Td>
            <Table.Td ta="right">{decimal(row.p50, 3)}</Table.Td>
            <Table.Td ta="right">{decimal(row.p99, 3)}</Table.Td>
          </Table.Tr>
        ))}
      </Table.Tbody>
    </Table>
  </Table.ScrollContainer>
);

export const StartupTable = ({
  rows,
}: {
  rows: readonly StartupRow[];
}): React.JSX.Element => {
  const slowest = rows.reduce((max, row) => Math.max(max, row.medianMs), 0);

  return (
    <Table.ScrollContainer minWidth={700}>
      <Table verticalSpacing="xs" fz="sm" highlightOnHover>
        <Table.Thead>
          <Table.Tr>
            <Table.Th w={170}>Subject</Table.Th>
            <Table.Th>Cold start - shorter is better</Table.Th>
            <Table.Th ta="right" w={100}>
              median ms
            </Table.Th>
            <Table.Th ta="right" w={90}>
              min ms
            </Table.Th>
            <Table.Th ta="right" w={90}>
              max ms
            </Table.Th>
            <Table.Th ta="right" w={110}>
              vs Bun.serve
            </Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {rows.map((row) => (
            <Table.Tr key={row.id} className={rowClass(row.id)}>
              <Table.Td>
                <Text
                  size="sm"
                  ff="monospace"
                  fw={row.id === FOCUS ? 700 : 400}
                  component="span"
                >
                  {row.label}
                </Text>
              </Table.Td>
              <Table.Td>
                <Bar
                  fraction={slowest === 0 ? 0 : (row.medianMs / slowest) * 100}
                  runtime={row.runtime}
                />
              </Table.Td>
              <Table.Td ta="right" fw={row.id === FOCUS ? 700 : 400}>
                {decimal(row.medianMs, 1)}
              </Table.Td>
              <Table.Td ta="right" c="dimmed">
                {decimal(row.minMs, 1)}
              </Table.Td>
              <Table.Td ta="right" c="dimmed">
                {decimal(row.maxMs, 1)}
              </Table.Td>
              <Table.Td ta="right">{decimal(row.ratioToBaseline, 2)}x</Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Table.ScrollContainer>
  );
};
