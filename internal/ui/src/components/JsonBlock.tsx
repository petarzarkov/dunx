import { Code } from '@mantine/core';
import type { JSX } from 'react';

/**
 * A JSON value, pretty-printed and allowed to scroll.
 *
 * A value that is already a string is shown verbatim rather than re-encoded: a
 * response body that failed to parse is exactly what someone wants to see, and
 * `JSON.stringify` of it would wrap the whole thing in quotes and escape every
 * newline - turning the readable failure into an unreadable one.
 */
export const stringify = (value: unknown): string => {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    // A cycle, or a BigInt. Neither is worth failing a render over.
    return String(value);
  }
};

export const JsonBlock = ({
  value,
  maxHeight,
}: {
  value: unknown;
  /** Caps a large payload so one job's data cannot push the page off screen. */
  maxHeight?: number | string;
}): JSX.Element => (
  <Code
    block
    className="dunx-json"
    {...(maxHeight === undefined
      ? {}
      : { style: { maxHeight, overflowY: 'auto' } })}
  >
    {stringify(value)}
  </Code>
);
