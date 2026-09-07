import { Table } from '@mantine/core';
import type { JSX, ReactNode } from 'react';
import { EmptyState } from './EmptyState.js';

export interface Column<T> {
  readonly key: string;
  readonly header: ReactNode;
  readonly render: (row: T, index: number) => ReactNode;
  /** A fixed width keeps a verb or a status column from breathing per page. */
  readonly width?: number | string;
  readonly align?: 'left' | 'right' | 'center';
  /**
   * Drop this column on a narrow viewport. A seven-column route table is 875px
   * wide on a 393px phone, so the columns after the second are reachable only
   * by scrolling the table sideways one row at a time.
   */
  readonly hideBelow?: 'sm' | 'md';
}

/**
 * Paired with the media queries in `styles.css`. A spread rather than a
 * `className` that may be undefined, which `exactOptionalPropertyTypes` refuses.
 */
const hidden = (below: 'sm' | 'md' | undefined): { className?: string } =>
  below === undefined ? {} : { className: `dunx-hide-below-${below}` };

/**
 * The table every panel that lists things uses.
 *
 * Column-driven rather than children-driven so a caller cannot get the header and
 * the cell order out of step - the pair that produced the bug is declared once, in
 * one object. `render` takes the row rather than a key path because most columns
 * here are a badge or a group of them, not a string.
 *
 * The empty case is part of the table, not the caller's job. A panel that renders
 * a header row over nothing looks broken, and every caller writing its own
 * "nothing here" is how eight panels end up with eight wordings.
 */
export const DataTable = <T,>({
  columns,
  rows,
  rowKey,
  onRowClick,
  empty,
  highlightOnHover = true,
  minWidth = 320,
}: {
  columns: readonly Column<T>[];
  rows: readonly T[];
  rowKey: (row: T, index: number) => string;
  onRowClick?: (row: T) => void;
  /** Shown instead of the table when `rows` is empty. */
  empty?: ReactNode;
  highlightOnHover?: boolean;
  /**
   * What the table may shrink to before its container scrolls. Low enough that
   * the columns a phone keeps can compress into it rather than overflow.
   */
  minWidth?: number | string;
}): JSX.Element => {
  if (rows.length === 0) {
    return <>{empty ?? <EmptyState title="Nothing to show" />}</>;
  }

  return (
    <Table.ScrollContainer minWidth={minWidth}>
      <Table
        highlightOnHover={highlightOnHover}
        verticalSpacing="xs"
        horizontalSpacing="sm"
        fz="sm"
      >
        <Table.Thead>
          <Table.Tr>
            {columns.map((column) => (
              <Table.Th
                key={column.key}
                {...hidden(column.hideBelow)}
                style={{
                  ...(column.width === undefined
                    ? {}
                    : { width: column.width }),
                  ...(column.align === undefined
                    ? {}
                    : { textAlign: column.align }),
                }}
              >
                {column.header}
              </Table.Th>
            ))}
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {rows.map((row, index) => (
            <Table.Tr
              key={rowKey(row, index)}
              {...(onRowClick && {
                onClick: () => onRowClick(row),
                style: { cursor: 'pointer' },
              })}
            >
              {columns.map((column) => (
                <Table.Td
                  key={column.key}
                  {...hidden(column.hideBelow)}
                  {...(column.align && {
                    style: { textAlign: column.align },
                  })}
                >
                  {column.render(row, index)}
                </Table.Td>
              ))}
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Table.ScrollContainer>
  );
};
