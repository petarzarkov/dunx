import { Badge, Box, Code, Group, Stack, Table, Text } from '@mantine/core';
import type { JSX } from 'react';
import { refName, type JsonSchema } from '../model';

type Schemas = Readonly<Record<string, JsonSchema>>;

const str = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined;

const list = (value: unknown): readonly unknown[] =>
  Array.isArray(value) ? value : [];

const sub = (value: unknown): JsonSchema | undefined =>
  typeof value === 'object' && value !== null
    ? (value as JsonSchema)
    : undefined;

export const resolve = (schema: JsonSchema, schemas: Schemas): JsonSchema => {
  const name = refName(schema);
  return name === undefined ? schema : (schemas[name] ?? schema);
};

/** `array of User`, `string · uuid`, `integer` — what the reader needs at a glance. */
export const typeLabel = (schema: JsonSchema, schemas: Schemas): string => {
  const name = refName(schema);
  if (name !== undefined) return name;

  for (const key of ['oneOf', 'anyOf', 'allOf'] as const) {
    const branches = list(schema[key]);
    if (branches.length > 0) {
      const joiner = key === 'allOf' ? ' & ' : ' | ';
      return branches
        .map((branch) => typeLabel(branch as JsonSchema, schemas))
        .join(joiner);
    }
  }

  const raw = schema['type'];
  const type = Array.isArray(raw) ? raw.join(' | ') : str(raw);
  if (type === 'array') {
    const items = sub(schema['items']);
    return `array of ${items === undefined ? 'any' : typeLabel(items, schemas)}`;
  }
  const format = str(schema['format']);
  if (type === undefined)
    return list(schema['enum']).length > 0 ? 'enum' : 'any';
  return format === undefined ? type : `${type} · ${format}`;
};

const CONSTRAINTS = [
  ['minimum', '≥'],
  ['maximum', '≤'],
  ['minLength', 'min length'],
  ['maxLength', 'max length'],
  ['minItems', 'min items'],
  ['maxItems', 'max items'],
  ['pattern', 'pattern'],
] as const;

const Facts = ({ schema }: { schema: JsonSchema }): JSX.Element | null => {
  const enumerated = list(schema['enum']);
  const constraints = CONSTRAINTS.filter(
    ([key]) => schema[key] !== undefined,
  ).map(([key, label]) => `${label} ${String(schema[key])}`);

  if (enumerated.length === 0 && constraints.length === 0) return null;

  return (
    <Group gap={4} mt={2}>
      {enumerated.map((value) => (
        <Badge key={String(value)} size="xs" variant="light" color="gray">
          {String(value)}
        </Badge>
      ))}
      {constraints.map((text) => (
        <Badge key={text} size="xs" variant="outline" color="gray">
          {text}
        </Badge>
      ))}
    </Group>
  );
};

interface RowsProps {
  readonly schema: JsonSchema;
  readonly schemas: Schemas;
  readonly depth: number;
  readonly seen: readonly string[];
}

const MAX_DEPTH = 4;

const nestedOf = (
  property: JsonSchema,
  schemas: Schemas,
): JsonSchema | undefined => {
  const resolved = resolve(property, schemas);
  if (resolved['properties'] !== undefined) return resolved;
  const items = sub(resolved['items']);
  if (items === undefined) return undefined;
  const inner = resolve(items, schemas);
  return inner['properties'] === undefined ? undefined : inner;
};

const PropertyRows = ({
  schema,
  schemas,
  depth,
  seen,
}: RowsProps): readonly JSX.Element[] => {
  const properties = sub(schema['properties']) ?? {};
  const required = new Set(list(schema['required']).map(String));

  return Object.entries(properties).flatMap(([name, raw]) => {
    const property = raw as JsonSchema;
    const ref = refName(property);
    const cycles = ref !== undefined && seen.includes(ref);
    const nested = cycles ? undefined : nestedOf(property, schemas);
    const description = str(resolve(property, schemas)['description']);

    const row = (
      <Table.Tr key={`${depth}-${name}`}>
        <Table.Td style={{ paddingLeft: `${depth * 1.1 + 0.5}rem` }}>
          <Code>{name}</Code>
          {required.has(name) && (
            <Text span c="red" ml={4} fw={700} aria-label="required">
              *
            </Text>
          )}
        </Table.Td>
        <Table.Td>
          <Text size="xs" c="dimmed" ff="monospace">
            {typeLabel(property, schemas)}
          </Text>
          <Facts schema={resolve(property, schemas)} />
        </Table.Td>
        <Table.Td>
          <Text size="xs" c="dimmed">
            {description ?? (cycles ? 'recursive' : '')}
          </Text>
        </Table.Td>
      </Table.Tr>
    );

    if (nested === undefined || depth + 1 > MAX_DEPTH) return [row];
    return [
      row,
      ...PropertyRows({
        schema: nested,
        schemas,
        depth: depth + 1,
        seen: ref === undefined ? seen : [...seen, ref],
      }),
    ];
  });
};

export interface SchemaViewProps {
  readonly schema: JsonSchema;
  readonly schemas: Schemas;
}

/**
 * A schema shown as a schema: named type, property table with required markers,
 * constraints and enum values, plus the raw JSON underneath for anything this
 * does not model. The old page printed `JSON.stringify(schema, null, 2)`.
 */
export const SchemaView = ({
  schema,
  schemas,
}: SchemaViewProps): JSX.Element => {
  const name = refName(schema);
  const resolved = resolve(schema, schemas);
  const properties = sub(resolved['properties']);
  const items = sub(resolved['items']);
  const arrayOf = items === undefined ? undefined : resolve(items, schemas);
  const table = properties !== undefined ? resolved : arrayOf;
  const example = resolved['example'];

  return (
    <Stack gap="xs">
      <Group gap="xs">
        <Badge variant="light" color="gray" ff="monospace">
          {typeLabel(schema, schemas)}
        </Badge>
        {name !== undefined && (
          <Text size="xs" c="dimmed">
            #/components/schemas/{name}
          </Text>
        )}
      </Group>

      {str(resolved['description']) !== undefined && (
        <Text size="sm">{str(resolved['description'])}</Text>
      )}
      <Facts schema={resolved} />

      {table?.['properties'] !== undefined && (
        <Table
          striped
          highlightOnHover
          withTableBorder
          verticalSpacing={4}
          horizontalSpacing="sm"
        >
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Property</Table.Th>
              <Table.Th>Type</Table.Th>
              <Table.Th>Description</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {PropertyRows({
              schema: table,
              schemas,
              depth: 0,
              seen: name === undefined ? [] : [name],
            })}
          </Table.Tbody>
        </Table>
      )}

      {example !== undefined && (
        <Box>
          <Text size="xs" c="dimmed" mb={2}>
            Example
          </Text>
          <Code block className="dunx-json">
            {JSON.stringify(example, null, 2)}
          </Code>
        </Box>
      )}
    </Stack>
  );
};
