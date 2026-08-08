import {
  Anchor,
  Badge,
  Box,
  Code,
  Group,
  Paper,
  Stack,
  Table,
  Text,
  Title,
} from '@mantine/core';
import { Prose } from '@dunx/ui';
import type { DocMember, DocSymbol } from '../../scripts/extract/model';
import { symbolAnchor } from '../router';

const KIND_COLOR: Record<string, string> = {
  class: 'violet',
  function: 'blue',
  interface: 'teal',
  type: 'grape',
  variable: 'orange',
};

const MemberRow = ({ member }: { member: DocMember }): React.JSX.Element => (
  <Table.Tr>
    <Table.Td w="45%">
      <Code block className="member-signature">
        {member.signature}
      </Code>
    </Table.Td>
    <Table.Td>
      <Group gap={6} mb={member.doc ? 4 : 0}>
        {member.isStatic && (
          <Badge size="xs" variant="light" color="gray">
            static
          </Badge>
        )}
        <Badge size="xs" variant="light" color="gray">
          {member.kind}
        </Badge>
      </Group>
      {member.doc?.summary ? <Prose html={member.doc.summary} /> : null}
      {member.doc?.tags.map((tag) => (
        <Group key={tag.name + tag.text} gap={6} align="baseline" wrap="nowrap">
          <Text size="xs" c="dimmed" fw={600}>
            @{tag.name}
          </Text>
          <Prose html={tag.text} />
        </Group>
      ))}
    </Table.Td>
  </Table.Tr>
);

/**
 * `linked` is the symbol the current route's `?h=` names. It is a rendered
 * state rather than a class the scroll effect pokes on afterwards, so it
 * survives re-renders and a test can assert it.
 */
export const SymbolCard = ({
  symbol,
  repoUrl,
  linked = false,
}: {
  symbol: DocSymbol;
  repoUrl: string;
  linked?: boolean;
}): React.JSX.Element => (
  <Paper
    withBorder
    radius="md"
    p="md"
    id={symbolAnchor(symbol.name)}
    className={linked ? 'symbol-card symbol-card-linked' : 'symbol-card'}
    data-linked={linked || undefined}
  >
    <Stack gap="sm">
      <Group justify="space-between" align="flex-start" wrap="nowrap">
        <Group gap="xs" align="baseline" wrap="wrap">
          <Title order={3} size="h4" ff="monospace">
            {symbol.name}
          </Title>
          <Badge
            size="sm"
            variant="light"
            color={KIND_COLOR[symbol.kind] ?? 'gray'}
          >
            {symbol.kind}
          </Badge>
          {symbol.deprecated && (
            <Badge size="sm" color="red" variant="light">
              deprecated
            </Badge>
          )}
          {symbol.subpaths.length === 0 && (
            <Badge size="sm" variant="outline" color="gray">
              internal
            </Badge>
          )}
        </Group>
        <Anchor
          href={`${repoUrl}/blob/main/${symbol.file}#L${symbol.line}`}
          target="_blank"
          size="xs"
          c="dimmed"
          style={{ whiteSpace: 'nowrap' }}
        >
          {symbol.file.replace(/^packages\/[^/]+\/src\//, '')}:{symbol.line}
        </Anchor>
      </Group>

      <Code block className="signature">
        {symbol.signature}
      </Code>

      {symbol.subpaths.length > 0 && (
        <Group gap={6}>
          <Text size="xs" c="dimmed">
            exported from
          </Text>
          {symbol.subpaths.map((subpath) => (
            <Badge key={subpath} size="xs" variant="default">
              {subpath}
            </Badge>
          ))}
        </Group>
      )}

      {symbol.doc?.summary ? <Prose html={symbol.doc.summary} /> : null}

      {symbol.doc?.tags.length ? (
        <Stack gap={4}>
          {symbol.doc.tags.map((tag) => (
            <Box key={tag.name + tag.text}>
              <Text size="xs" c="dimmed" fw={600} component="span" mr={6}>
                @{tag.name}
              </Text>
              <Prose html={tag.text} />
            </Box>
          ))}
        </Stack>
      ) : null}

      {symbol.members.length > 0 && (
        <Table verticalSpacing="xs" horizontalSpacing="sm" layout="fixed">
          <Table.Tbody>
            {symbol.members.map((member) => (
              <MemberRow
                key={`${member.kind}-${member.name}-${member.line}`}
                member={member}
              />
            ))}
          </Table.Tbody>
        </Table>
      )}
    </Stack>
  </Paper>
);
