import {
  Accordion,
  Badge,
  Code,
  Divider,
  Group,
  Stack,
  Table,
  Text,
} from '@mantine/core';
import type { JSX } from 'react';
import { authFor, type AuthState } from '../auth';
import {
  isPublic,
  schemeNames,
  statusColor,
  METHOD_COLOR,
  type Entry,
  type JsonSchema,
  type PageModel,
  type SecuritySchemeObject,
} from '../model';
import { LockIcon } from './Icons';
import { Prose } from './Prose';
import { SchemaView, typeLabel } from './SchemaView';
import { TryIt } from './TryIt';

type Schemas = Readonly<Record<string, JsonSchema>>;

const Section = ({
  title,
  children,
}: {
  title: string;
  children: JSX.Element;
}): JSX.Element => (
  <Stack gap={6}>
    <Text tt="uppercase" fz="xs" fw={700} c="dimmed" lts=".06em">
      {title}
    </Text>
    {children}
  </Stack>
);

const Parameters = ({
  entry,
  schemas,
}: {
  entry: Entry;
  schemas: Schemas;
}): JSX.Element => (
  <Table verticalSpacing={4} horizontalSpacing="sm" withTableBorder striped>
    <Table.Thead>
      <Table.Tr>
        <Table.Th>Name</Table.Th>
        <Table.Th>In</Table.Th>
        <Table.Th>Type</Table.Th>
        <Table.Th>Description</Table.Th>
      </Table.Tr>
    </Table.Thead>
    <Table.Tbody>
      {(entry.operation.parameters ?? []).map((parameter) => (
        <Table.Tr key={`${parameter.in}:${parameter.name}`}>
          <Table.Td>
            <Code>{parameter.name}</Code>
            {parameter.required === true && (
              <Text span c="red" ml={4} fw={700}>
                *
              </Text>
            )}
          </Table.Td>
          <Table.Td>
            <Badge size="xs" variant="light" color="gray">
              {parameter.in}
            </Badge>
          </Table.Td>
          <Table.Td>
            <Text fz="xs" ff="monospace" c="dimmed">
              {typeLabel(parameter.schema, schemas)}
            </Text>
          </Table.Td>
          <Table.Td>
            <Text fz="xs" c="dimmed">
              {parameter.description ?? ''}
            </Text>
          </Table.Td>
        </Table.Tr>
      ))}
    </Table.Tbody>
  </Table>
);

const Responses = ({
  entry,
  schemas,
}: {
  entry: Entry;
  schemas: Schemas;
}): JSX.Element => (
  <Stack gap="xs">
    {Object.entries(entry.operation.responses).map(([status, response]) => {
      const media = Object.entries(response.content ?? {});
      return (
        <Stack key={status} gap={4}>
          <Group gap="xs">
            <Badge color={statusColor(status)} variant="light" ff="monospace">
              {status}
            </Badge>
            <Text fz="sm">{response.description}</Text>
            {media.map(([type]) => (
              <Text key={type} fz="xs" c="dimmed" ff="monospace">
                {type}
              </Text>
            ))}
          </Group>
          {media.map(([type, value]) => (
            <SchemaView key={type} schema={value.schema} schemas={schemas} />
          ))}
        </Stack>
      );
    })}
  </Stack>
);

const Security = ({
  entry,
  schemes,
}: {
  entry: Entry;
  schemes: Readonly<Record<string, SecuritySchemeObject>>;
}): JSX.Element => {
  const names = schemeNames(entry.operation);
  const roles = entry.operation['x-required-roles'] ?? [];

  return (
    <Group gap="xs">
      {isPublic(entry.operation) && (
        <Badge variant="light" color="gray">
          public
        </Badge>
      )}
      {names.map((name) => (
        <Badge key={name} variant="light" color="indigo" ff="monospace">
          {name}
          {schemes[name] === undefined ? '' : ` · ${schemes[name].type}`}
        </Badge>
      ))}
      {roles.map((role) => (
        <Badge key={role} variant="outline" color="grape">
          role: {role}
        </Badge>
      ))}
    </Group>
  );
};

export interface OperationProps {
  readonly entry: Entry;
  readonly model: PageModel;
  readonly auth: AuthState;
}

/**
 * One operation, behind a real disclosure control: Mantine's `Accordion.Item`
 * gives the chevron, the animation and the `aria-expanded` a bare `<details>`
 * did not.
 */
export const Operation = ({
  entry,
  model,
  auth,
}: OperationProps): JSX.Element => {
  const { operation, path, method } = entry;
  const schemas = model.document.components.schemas;
  const schemes = model.document.components.securitySchemes ?? {};
  const guarded = schemeNames(operation);
  const body = Object.entries(operation.requestBody?.content ?? {});
  const value = `${method}:${path}`;

  return (
    <Accordion.Item value={value} data-operation={operation.operationId}>
      <Accordion.Control>
        <Group gap="sm" wrap="nowrap">
          <Badge
            className="dunx-verb"
            color={METHOD_COLOR[method]}
            variant="filled"
          >
            {method.toUpperCase()}
          </Badge>
          <Text ff="monospace" fz="sm" fw={600}>
            {path}
          </Text>
          {guarded.length > 0 && (
            <Text
              c="dimmed"
              component="span"
              display="flex"
              title={`Requires ${guarded.join(', ')}`}
            >
              <LockIcon />
            </Text>
          )}
          <Text fz="sm" c="dimmed" truncate>
            {operation.summary ?? ''}
          </Text>
          {operation.deprecated === true && (
            <Badge color="orange" variant="light">
              deprecated
            </Badge>
          )}
        </Group>
      </Accordion.Control>

      <Accordion.Panel>
        <Stack gap="md">
          <Text fz="xs" c="dimmed" ff="monospace">
            {operation.operationId}
          </Text>
          <Prose html={model.prose[`op:${operation.operationId}`]} />

          {(operation.security !== undefined ||
            (operation['x-required-roles'] ?? []).length > 0) && (
            <Section title="Security">
              <Security entry={entry} schemes={schemes} />
            </Section>
          )}

          {(operation.parameters ?? []).length > 0 && (
            <Section title="Parameters">
              <Parameters entry={entry} schemas={schemas} />
            </Section>
          )}

          {body.map(([type, value_]) => (
            <Section key={type} title={`Request body - ${type}`}>
              <SchemaView schema={value_.schema} schemas={schemas} />
            </Section>
          ))}

          <Section title="Responses">
            <Responses entry={entry} schemas={schemas} />
          </Section>

          <Divider label="Send it" labelPosition="left" />
          <TryIt
            method={method}
            path={path}
            operationId={operation.operationId}
            fields={model.fields[operation.operationId] ?? []}
            auth={authFor(schemes, auth, guarded)}
            {...(model.samples[operation.operationId] === undefined
              ? {}
              : { sample: model.samples[operation.operationId] })}
          />
        </Stack>
      </Accordion.Panel>
    </Accordion.Item>
  );
};
