import { COMPONENTS_PREFIX } from './refs.js';
import type { JsonSchema } from './types.js';

type Schemas = Readonly<Record<string, JsonSchema>>;

/** Deep enough for a realistic body, shallow enough that a cycle cannot run away. */
const MAX_DEPTH = 6;

const resolve = (schema: JsonSchema, schemas: Schemas): JsonSchema => {
  const ref = schema['$ref'];
  if (typeof ref !== 'string' || !ref.startsWith(COMPONENTS_PREFIX)) {
    return schema;
  }
  return schemas[ref.slice(COMPONENTS_PREFIX.length)] ?? {};
};

const first = (value: unknown): unknown =>
  Array.isArray(value) && value.length > 0 ? value[0] : undefined;

const forString = (schema: JsonSchema): string => {
  const format = schema['format'];
  if (format === 'date-time') return new Date().toISOString();
  if (format === 'date') return new Date().toISOString().slice(0, 10);
  if (format === 'uuid') return '00000000-0000-4000-8000-000000000000';
  if (format === 'email') return 'user@example.com';
  if (format === 'uri' || format === 'url') return 'https://example.com';
  const min = schema['minLength'];
  return typeof min === 'number' && min > 6 ? 'x'.repeat(min) : 'string';
};

const forNumber = (schema: JsonSchema): number => {
  const min = schema['minimum'];
  const max = schema['maximum'];
  if (typeof min === 'number') return min;
  if (typeof max === 'number') return max;
  return 0;
};

/**
 * A plausible value for a schema, used to pre-fill the request body so a route
 * can be sent without anyone typing JSON by hand.
 *
 * Best effort by design: it reads `example`, `default` and `enum` first, then
 * falls back to the type. A body it gets wrong is a 400 the reader can see and
 * correct in the box, which is strictly better than an empty textarea.
 */
export const sampleFor = (
  schema: JsonSchema,
  schemas: Schemas,
  depth = 0,
): unknown => {
  if (depth > MAX_DEPTH) return null;
  const node = resolve(schema, schemas);

  if (node['example'] !== undefined) return node['example'];
  if (node['default'] !== undefined) return node['default'];
  if (node['const'] !== undefined) return node['const'];
  const enumerated = first(node['enum']);
  if (enumerated !== undefined) return enumerated;

  // A union picks its first branch: any one of them is a valid starting point,
  // and offering all of them in a textarea would not be.
  for (const key of ['oneOf', 'anyOf', 'allOf'] as const) {
    const branch = first(node[key]);
    if (branch !== undefined) {
      return sampleFor(branch as JsonSchema, schemas, depth + 1);
    }
  }

  const type = Array.isArray(node['type']) ? node['type'][0] : node['type'];

  switch (type) {
    case 'object': {
      const properties = node['properties'];
      if (typeof properties !== 'object' || properties === null) return {};
      const out: Record<string, unknown> = {};
      for (const [name, property] of Object.entries(properties)) {
        out[name] = sampleFor(property as JsonSchema, schemas, depth + 1);
      }
      return out;
    }
    case 'array': {
      const items = node['items'];
      return items === undefined
        ? []
        : [sampleFor(items as JsonSchema, schemas, depth + 1)];
    }
    case 'string':
      return forString(node);
    case 'integer':
    case 'number':
      return forNumber(node);
    case 'boolean':
      return false;
    case 'null':
      return null;
    default:
      // No `type` and no composition — an unconstrained schema. `{}` is the
      // honest answer, and the reader edits it.
      return node['properties'] === undefined ? null : {};
  }
};
