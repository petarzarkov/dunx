import {
  Badge,
  Box,
  Button,
  Code,
  Group,
  SimpleGrid,
  Stack,
  Table,
  Tabs,
  Text,
  Textarea,
  TextInput,
} from '@mantine/core';
import { JsonBlock, SendIcon } from '@dunx/ui';
import { useState, type JSX } from 'react';
import type { AuthParts } from '../auth';
import type { OperationKey, TryField } from '../model';
import {
  fieldKey,
  sendRequest,
  buildUrl,
  type FieldValues,
  type Outcome,
  type RequestSpec,
} from '../send';

const Response = ({ outcome }: { outcome: Outcome }): JSX.Element => (
  <Stack gap="xs" mt="sm">
    <Group gap="xs">
      <Badge color={outcome.ok ? 'green' : 'red'} variant="filled">
        {outcome.status === 0
          ? outcome.statusText
          : `${outcome.status} ${outcome.statusText}`}
      </Badge>
      <Text size="xs" c="dimmed" data-timing>
        {outcome.ms} ms · {outcome.bytes} B
      </Text>
      <Text
        size="xs"
        c="dimmed"
        ff="monospace"
        style={{ wordBreak: 'break-all' }}
      >
        {outcome.url}
      </Text>
    </Group>

    <Tabs defaultValue="body" variant="outline">
      <Tabs.List>
        <Tabs.Tab value="body">Body</Tabs.Tab>
        <Tabs.Tab value="headers">Headers ({outcome.headers.length})</Tabs.Tab>
      </Tabs.List>
      <Tabs.Panel value="body" pt="xs">
        <Box data-response-body>
          <JsonBlock
            value={outcome.body === '' ? '(empty)' : outcome.body}
            maxHeight={360}
          />
        </Box>
      </Tabs.Panel>
      <Tabs.Panel value="headers" pt="xs">
        <Box mah={240} style={{ overflow: 'auto' }}>
          <Table verticalSpacing={2} horizontalSpacing="sm" fz="xs">
            <Table.Tbody>
              {outcome.headers.map(([name, value]) => (
                <Table.Tr key={name}>
                  <Table.Td ff="monospace">{name}</Table.Td>
                  <Table.Td ff="monospace" style={{ wordBreak: 'break-all' }}>
                    {value}
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Box>
      </Tabs.Panel>
    </Tabs>
  </Stack>
);

export interface TryItProps {
  readonly method: OperationKey;
  readonly path: string;
  readonly operationId: string;
  readonly fields: readonly TryField[];
  /** The `sampleFor` body the server pre-computed, absent for a bodyless route. */
  readonly sample?: string;
  readonly auth: AuthParts;
}

/**
 * The form that makes an operation executable.
 *
 * Everything the previous page's inline client did is still here - path
 * substitution, query parameters only when filled, the schema-derived body, the
 * free-text header box - with the credentials from the dialog folded in and the
 * response split into a body and a header tab.
 */
export const TryIt = ({
  method,
  path,
  operationId,
  fields,
  sample,
  auth,
}: TryItProps): JSX.Element => {
  const [values, setValues] = useState<FieldValues>({});
  const [headerLines, setHeaderLines] = useState('');
  const [body, setBody] = useState(sample ?? '');
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | undefined>(undefined);

  const spec: RequestSpec = {
    method,
    path,
    fields,
    values,
    headerLines,
    auth,
    ...(sample === undefined ? {} : { body }),
  };

  const submit = async (event: { preventDefault: () => void }) => {
    event.preventDefault();
    setBusy(true);
    try {
      setOutcome(await sendRequest(spec, location.origin));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} data-try={operationId} className="dunx-monospace">
      <Stack gap="sm">
        {fields.length > 0 && (
          <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="xs">
            {fields.map((field) => (
              <TextInput
                key={fieldKey(field)}
                size="xs"
                label={field.name}
                description={field.in + (field.required ? ' · required' : '')}
                placeholder={field.placeholder}
                required={field.required}
                data-in={field.in}
                data-name={field.name}
                value={values[fieldKey(field)] ?? ''}
                onChange={(event) =>
                  setValues({
                    ...values,
                    [fieldKey(field)]: event.currentTarget.value,
                  })
                }
              />
            ))}
          </SimpleGrid>
        )}

        {sample !== undefined && (
          <Textarea
            size="xs"
            label="Request body"
            description="application/json, pre-filled from the schema"
            autosize
            minRows={5}
            maxRows={18}
            spellCheck={false}
            data-body
            value={body}
            onChange={(event) => setBody(event.currentTarget.value)}
          />
        )}

        <Textarea
          size="xs"
          label="Extra headers"
          description="one Name: value per line"
          autosize
          minRows={2}
          spellCheck={false}
          data-headers
          value={headerLines}
          onChange={(event) => setHeaderLines(event.currentTarget.value)}
        />

        <Group gap="sm" align="center">
          <Button
            type="submit"
            size="xs"
            loading={busy}
            leftSection={<SendIcon />}
          >
            Send
          </Button>
          <Code fz="xs" style={{ wordBreak: 'break-all' }}>
            {method.toUpperCase()} {buildUrl(spec, 'http://x').pathname}
            {buildUrl(spec, 'http://x').search}
          </Code>
        </Group>

        {outcome !== undefined && <Response outcome={outcome} />}
      </Stack>
    </form>
  );
};
