import { Alert, Anchor, Button, Stack, Text } from '@mantine/core';
import { DataTable, EmptyState, Panel, SendIcon, type Column } from '@dunx/ui';
import type { JSX } from 'react';
import type { Meta, QueuesReport } from '../api';
import { Redis } from './Redis';

/**
 * **dunx renders no queue UI.** This panel lists the queue names and hands off to
 * bull-board, mounted at `{basePath}/queues`.
 *
 * That is the whole panel on purpose. A table over `getJobCounts` was written here
 * and deleted: bull-board is years of edge cases - flows, job logs, the
 * repeatable-job editor, per-queue metrics - and re-deriving a worse version of it
 * is exactly the failure Rule 1's second half names. bull-board 8.6 ships an
 * official Bun adapter, so the one reason dunx had for doing it itself is gone.
 *
 * A link rather than an iframe: bull-board is a full application with its own
 * routing and its own theme, and framing it would fight both while pretending the
 * two pages are one.
 */
const columns: readonly Column<string>[] = [
  {
    key: 'name',
    header: 'Queue',
    render: (name) => (
      <Text className="dunx-mono" fw={600} size="sm">
        {name}
      </Text>
    ),
  },
];

export const Queues = ({
  report,
  redis,
  meta,
}: {
  report: QueuesReport | undefined;
  redis: React.ComponentProps<typeof Redis>['redis'];
  meta: Meta;
}): JSX.Element => (
  <Stack gap="md">
    <Panel
      title="Queues"
      description="Everything about a queue - counts, jobs, retries, flows, metrics - is bull-board's. dunx mounts it and stays out of the way."
      actions={
        report?.unavailable === undefined &&
        (report?.queues.length ?? 0) > 0 ? (
          <Button
            component="a"
            href={meta.queuesPath}
            target="_blank"
            rel="noreferrer"
            size="xs"
            rightSection={<SendIcon size={14} />}
          >
            Open bull-board
          </Button>
        ) : undefined
      }
    >
      {report?.unavailable !== undefined ? (
        <EmptyState title="No queue board" reason={report.unavailable} />
      ) : (
        <DataTable
          columns={columns}
          rows={report?.queues ?? []}
          rowKey={(name) => name}
          highlightOnHover={false}
          empty={<EmptyState title="Loading" />}
        />
      )}

      <Alert color="gray" variant="light" p="xs">
        <Text size="xs">
          The board opens at{' '}
          <Anchor href={meta.queuesPath} target="_blank" rel="noreferrer">
            <code>{meta.queuesPath}</code>
          </Anchor>
          . It is behind the same <code>authorize</code> as this page, and{' '}
          <code>commands: false</code> puts it in bull-board’s own read-only
          mode.
        </Text>
      </Alert>
    </Panel>

    <Redis redis={redis} />
  </Stack>
);
