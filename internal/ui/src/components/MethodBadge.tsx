import { Badge } from '@mantine/core';
import type { JSX } from 'react';
import { methodColor } from '../colors.js';

/**
 * An HTTP verb, coloured the same way on every dunx page.
 *
 * `.dunx-verb` fixes the width, which is what gives a column of these one left
 * edge - the thing that makes a route table scannable. Uppercase is applied here
 * rather than expected from the caller: `routesOf` reports `GET` and an OpenAPI
 * document says `get`, and neither should have to know about the other.
 */
export const MethodBadge = ({
  method,
  size = 'sm',
  variant = 'light',
}: {
  method: string;
  size?: string;
  /** `filled` for a row that is itself the control, `light` inside a table. */
  variant?: 'light' | 'filled' | 'outline';
}): JSX.Element => (
  <Badge
    className="dunx-verb"
    variant={variant}
    color={methodColor(method)}
    size={size}
  >
    {method.toUpperCase()}
  </Badge>
);
