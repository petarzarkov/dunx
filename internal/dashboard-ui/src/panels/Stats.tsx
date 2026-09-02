import { Alert, Badge, Group, SimpleGrid, Table, Text } from '@mantine/core';
import { EmptyState, Panel, StatCard } from '@dunx/ui';
import type { JSX } from 'react';
import type {
  DbStatsReport,
  HistogramSnapshot,
  HttpStatsReport,
  StatsHalf,
  StatsReport,
} from '../api';
import { count, duration } from '../format';

/**
 * Counts and timings, as two tables. No chart: a percentile per route is a
 * number a reader compares against the row above it, and `internal/docs` is
 * where charts earn their bytes.
 *
 * Durations arrive in nanoseconds, because that is what the native histogram
 * records. `duration()` takes milliseconds.
 */
const ms = (nanoseconds: number | undefined): string =>
  nanoseconds === undefined ? '-' : duration(nanoseconds / 1e6);

/** A `count === 0` histogram carries no percentiles at all, by construction. */
const percentiles = (histogram: HistogramSnapshot): string =>
  histogram.count === 0
    ? '-'
    : `${ms(histogram.p50)} / ${ms(histogram.p95)} / ${ms(histogram.p99)}`;

const statusBadges = (
  byStatus: Readonly<Record<string, number>>,
): JSX.Element => (
  <Group gap={4}>
    {Object.entries(byStatus)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([status, hits]) => (
        <Badge
          key={status}
          size="sm"
          variant="light"
          color={
            status.startsWith('2')
              ? 'green'
              : status.startsWith('4')
                ? 'yellow'
                : status.startsWith('5')
                  ? 'red'
                  : 'gray'
          }
        >
          {status} x{hits}
        </Badge>
      ))}
  </Group>
);

const Requests = ({
  http,
}: {
  http: StatsHalf<HttpStatsReport>;
}): JSX.Element => {
  if (http.configured === false) {
    return (
      <Panel title="Requests">
        <EmptyState
          title="No request metrics"
          reason="Pass `stats` to DashboardModule and set `metrics: true` on HttpFactory.create - RequestMetrics from @dunx/http satisfies it as written."
        />
      </Panel>
    );
  }

  // Slowest first: the reason anyone opens this panel.
  const rows = [...http.routes].sort(
    (a, b) => (b.duration.p99 ?? 0) - (a.duration.p99 ?? 0),
  );

  return (
    <Panel
      title="Requests"
      description={`since ${new Date(http.since).toLocaleTimeString()}`}
      actions={
        <Group gap="xs">
          <StatCard label="in flight" value={count(http.inFlight)} />
          <StatCard label="sockets" value={count(http.pendingWebSockets)} />
        </Group>
      }
    >
      {rows.length === 0 ? (
        <EmptyState
          title="Nothing served yet"
          reason="No request has completed since the counters were last reset."
        />
      ) : (
        <Table striped highlightOnHover>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Route</Table.Th>
              <Table.Th>Count</Table.Th>
              <Table.Th>p50 / p95 / p99</Table.Th>
              <Table.Th>Max</Table.Th>
              <Table.Th>Status</Table.Th>
              <Table.Th>Slowest trace</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {rows.map((row) => (
              <Table.Tr key={`${row.method} ${row.route}`}>
                <Table.Td>
                  <Group gap={6}>
                    <Badge size="sm" variant="light">
                      {row.method}
                    </Badge>
                    <Text size="sm" ff="monospace">
                      {row.route}
                    </Text>
                  </Group>
                </Table.Td>
                <Table.Td>{count(row.count)}</Table.Td>
                <Table.Td>{percentiles(row.duration)}</Table.Td>
                <Table.Td>{ms(row.duration.max)}</Table.Td>
                <Table.Td>{statusBadges(row.byStatus)}</Table.Td>
                <Table.Td>
                  <Text size="xs" ff="monospace" c="dimmed">
                    {row.slowestTraceId ?? '-'}
                  </Text>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      )}
    </Panel>
  );
};

const Queries = ({ db }: { db: StatsHalf<DbStatsReport> }): JSX.Element => {
  if (db.configured === false) {
    return (
      <Panel title="Database">
        <EmptyState
          title="No query metrics"
          reason="Pass `dbStats` to DashboardModule and open the database with DbModule.forRoot(options, { metrics: true })."
        />
      </Panel>
    );
  }

  return (
    <Panel
      title="Database"
      description={`${count(db.total)} queries since ${new Date(db.since).toLocaleTimeString()}`}
    >
      {db.operations.length === 0 ? (
        <EmptyState
          title="No queries yet"
          reason="Nothing has run against the database since the counters were last reset."
        />
      ) : (
        <Table striped highlightOnHover>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Operation</Table.Th>
              <Table.Th>Count</Table.Th>
              <Table.Th>Errors</Table.Th>
              <Table.Th>p50 / p95 / p99</Table.Th>
              <Table.Th>Max</Table.Th>
              <Table.Th>Slowest</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {db.operations.map((row) => (
              <Table.Tr key={row.operation}>
                <Table.Td>
                  <Badge size="sm" variant="light">
                    {row.operation}
                  </Badge>
                </Table.Td>
                <Table.Td>{count(row.count)}</Table.Td>
                <Table.Td>
                  {row.errors > 0 ? (
                    <Text size="sm" c="red">
                      {count(row.errors)}
                    </Text>
                  ) : (
                    <Text size="sm">{count(row.errors)}</Text>
                  )}
                </Table.Td>
                <Table.Td>{percentiles(row.duration)}</Table.Td>
                <Table.Td>{ms(row.duration.max)}</Table.Td>
                <Table.Td>
                  <Text size="xs" ff="monospace" c="dimmed" lineClamp={1}>
                    {row.slowest ?? '-'}
                  </Text>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      )}
    </Panel>
  );
};

export const Stats = ({
  report,
  error,
}: {
  report: StatsReport | undefined;
  error?: string | undefined;
}): JSX.Element => {
  // Distinguished from loading: a failed poll left `report` undefined too, and
  // showing "Loading" forever is the worst of the three states to show.
  if (error !== undefined) {
    return (
      <Alert color="red" title="Could not read the counters">
        {error}
      </Alert>
    );
  }
  if (report === undefined) {
    return (
      <Panel title="Stats">
        <EmptyState title="Loading" reason="Reading the counters." />
      </Panel>
    );
  }
  return (
    <SimpleGrid cols={1} spacing="lg">
      <Requests http={report.http} />
      <Queries db={report.db} />
    </SimpleGrid>
  );
};
