import type {
  StandardSchemaResult,
  StandardSchemaV1,
} from '../route/schema.js';

/**
 * A Standard Schema by hand, the point being that no dependency is involved:
 * `@dunx/http` validates through the interface and must never need a validator to
 * prove it.
 */
export const schema = <T>(
  validate: (
    value: unknown,
  ) => StandardSchemaResult<T> | Promise<StandardSchemaResult<T>>,
): StandardSchemaV1<unknown, T> => ({
  '~standard': { version: 1, vendor: 'test', validate },
});

export const field = (value: unknown, key: string): unknown =>
  typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)[key]
    : undefined;

/** The one body shape the input suites share. */
export const Note = schema<{ text: string }>((value) => {
  const text = field(value, 'text');
  return typeof text === 'string'
    ? { value: { text } }
    : { issues: [{ message: 'text must be a string', path: ['text'] }] };
});

/** The one body shape the fast-path suites share: `name` must be a string. */
export const named = schema<{ name: string }>((value) => {
  const name = field(value, 'name');
  return typeof name === 'string'
    ? { value: { name } }
    : { issues: [{ message: 'name must be a string', path: ['name'] }] };
});
