import { Text } from '@mantine/core';
import type { JSX, ReactNode } from 'react';

/**
 * The heading over a group of `NavLink`s in a sidebar.
 *
 * It exists because the documentation site had these six props written out at
 * four call sites and the dashboard had no groups at all, so its navbar was one
 * flat list of panels. The two shells are meant to be indistinguishable, which
 * is the reason `@dunx/ui` exists at all.
 */
export const NavGroupLabel = ({
  children,
}: {
  children: ReactNode;
}): JSX.Element => (
  <Text size="xs" fw={700} tt="uppercase" c="dimmed" mt="md" mb={4} px="xs">
    {children}
  </Text>
);
