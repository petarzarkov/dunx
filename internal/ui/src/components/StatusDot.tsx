import { Group, Text } from '@mantine/core';
import type { JSX, ReactNode } from 'react';
import { HEALTH_COLOR, type HealthState } from '../colors.js';

/**
 * Is it up.
 *
 * Three states rather than a boolean, because "we could not tell" is a different
 * fact from "it is down" and a dashboard that renders them the same sends someone
 * to look at a healthy service. `unknown` is grey and says so.
 *
 * A dot plus a word, never a dot alone: colour is not readable to everyone, and a
 * bare green circle in a table has no accessible name.
 */
export const StatusDot = ({
  state,
  label,
}: {
  state: HealthState;
  /** Defaults to the state itself, which is usually the right word for it. */
  label?: ReactNode;
}): JSX.Element => (
  <Group gap={6} wrap="nowrap" align="center">
    <span
      aria-hidden="true"
      style={{
        width: 8,
        height: 8,
        borderRadius: '50%',
        flexShrink: 0,
        background: `var(--mantine-color-${HEALTH_COLOR[state]}-filled)`,
      }}
    />
    <Text size="sm" {...(state === 'unknown' && { c: 'dimmed' })}>
      {label ?? state}
    </Text>
  </Group>
);
