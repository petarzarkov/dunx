import { Stack, Text } from '@mantine/core';
import type { JSX, ReactNode } from 'react';

/**
 * Nothing here, and why.
 *
 * The `reason` is the whole point. "No queues" is indistinguishable from a
 * misconfiguration; "No queues - this process has not opened one, so nothing has
 * been published from it yet" is not. Every empty panel in the dashboard says
 * which of the two it is.
 */
export const EmptyState = ({
  title,
  reason,
  action,
}: {
  title: ReactNode;
  reason?: ReactNode;
  action?: ReactNode;
}): JSX.Element => (
  <Stack gap={6} align="center" py="lg" px="md">
    <Text size="sm" fw={600} c="dimmed" ta="center">
      {title}
    </Text>
    {reason !== undefined && (
      <Text size="xs" c="dimmed" ta="center" maw={520}>
        {reason}
      </Text>
    )}
    {action}
  </Stack>
);
