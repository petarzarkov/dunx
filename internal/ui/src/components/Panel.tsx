import { Group, Paper, Stack, Text, Title } from '@mantine/core';
import type { JSX, ReactNode } from 'react';

/**
 * A titled section. The unit every dunx page is built out of: a heading, an
 * optional one-line explanation, an optional control on the right, and content.
 *
 * `Paper withBorder` rather than a shadow, because these tile - a page of eight
 * shadowed cards reads as eight floating things rather than one document.
 */
export const Panel = ({
  title,
  description,
  actions,
  children,
}: {
  title: ReactNode;
  description?: ReactNode;
  /** Right-aligned in the header: a filter, a refresh control, a count. */
  actions?: ReactNode;
  children: ReactNode;
}): JSX.Element => (
  <Paper withBorder radius="md" p="md">
    <Stack gap="sm">
      <Group justify="space-between" align="flex-start" wrap="nowrap" gap="md">
        <Stack gap={2}>
          <Title order={3} fz="h5">
            {title}
          </Title>
          {description !== undefined && (
            <Text size="xs" c="dimmed">
              {description}
            </Text>
          )}
        </Stack>
        {actions}
      </Group>
      {children}
    </Stack>
  </Paper>
);
