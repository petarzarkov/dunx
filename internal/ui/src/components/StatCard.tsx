import { Paper, Stack, Text } from '@mantine/core';
import type { JSX, ReactNode } from 'react';

/**
 * One number and what it counts.
 *
 * The value is monospace and the label is not, so a row of these lines up on the
 * digits rather than on the words - which is the only thing that makes a row of
 * counters comparable at a glance.
 */
export const StatCard = ({
  label,
  value,
  hint,
  color,
}: {
  label: ReactNode;
  value: ReactNode;
  /** A secondary line under the value: a unit, a ratio, a timestamp. */
  hint?: ReactNode;
  /** Mantine colour name. Absent leaves the value in the body colour, which is
   *  the right default: colouring every counter makes none of them stand out. */
  color?: string;
}): JSX.Element => (
  <Paper withBorder radius="md" p="sm">
    <Stack gap={2}>
      <Text size="xs" c="dimmed" tt="uppercase" fw={600} lh={1.3}>
        {label}
      </Text>
      <Text
        fz="xl"
        fw={700}
        ff="monospace"
        lh={1.2}
        {...(color && { c: color })}
      >
        {value}
      </Text>
      {hint !== undefined && (
        <Text size="xs" c="dimmed" lh={1.3}>
          {hint}
        </Text>
      )}
    </Stack>
  </Paper>
);
