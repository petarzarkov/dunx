import { Card, Text } from '@mantine/core';

/**
 * One figure with its label, as the coverage and benchmark pages show it.
 *
 * Distinct from `@dunx/ui`'s `StatCard`, which the dashboard uses: that one is
 * monospace on a `Paper` so a dense grid of counters lines up on the digits.
 * This one is a larger figure on a `Card`, for a page showing three of them.
 */
export const Stat = ({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}): React.JSX.Element => (
  <Card withBorder radius="md" padding="md">
    <Text size="xs" tt="uppercase" c="dimmed" fw={600}>
      {label}
    </Text>
    <Text fz={32} fw={700} lh={1.2}>
      {value}
    </Text>
    {hint !== undefined && (
      <Text size="xs" c="dimmed">
        {hint}
      </Text>
    )}
  </Card>
);
