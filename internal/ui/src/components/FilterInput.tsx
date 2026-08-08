import { CloseButton, TextInput } from '@mantine/core';
import type { JSX } from 'react';
import { SearchIcon } from '../icons.js';

/**
 * Narrow a list that is already loaded.
 *
 * Deliberately not debounced and deliberately not a form: everything it filters
 * is in memory, so the answer is a `String.includes` away and any delay is one
 * the user can feel for no benefit. Anything that has to ask the server for a
 * filtered result should say so with its own control rather than pretending to
 * be this.
 */
export const FilterInput = ({
  value,
  onChange,
  placeholder = 'Filter',
  width = 240,
}: {
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  width?: number | string;
}): JSX.Element => (
  <TextInput
    value={value}
    onChange={(event) => onChange(event.currentTarget.value)}
    placeholder={placeholder}
    size="xs"
    w={width}
    leftSection={<SearchIcon size={14} />}
    aria-label={placeholder}
    rightSection={
      value === '' ? null : (
        <CloseButton
          size="sm"
          onClick={() => onChange('')}
          aria-label="Clear"
        />
      )
    }
  />
);
