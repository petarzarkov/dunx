import {
  Accordion,
  ActionIcon,
  Alert,
  Anchor,
  Badge,
  Button,
  Code,
  Container,
  Group,
  List,
  MantineProvider,
  Paper,
  Stack,
  Text,
  TextInput,
  Title,
  useMantineColorScheme,
} from '@mantine/core';
import { theme } from '@dunx/ui';
import { useMemo, useState, type JSX } from 'react';
import { configured, loadAuth, saveAuth, type AuthState } from './auth';
import { AuthDialog } from './components/AuthDialog';
import { LockIcon, MoonIcon, SunIcon } from './components/Icons';
import { Operation } from './components/Operation';
import { Prose } from './components/Prose';
import { SchemaView } from './components/SchemaView';
import { entriesOf, groupByTag, matches, type PageModel } from './model';

const ColorSchemeToggle = (): JSX.Element => {
  const { colorScheme, toggleColorScheme } = useMantineColorScheme({
    keepTransitions: true,
  });
  const dark = colorScheme === 'dark';

  return (
    <ActionIcon
      variant="default"
      size="lg"
      onClick={toggleColorScheme}
      title={dark ? 'Light theme' : 'Dark theme'}
      aria-label="Toggle colour scheme"
    >
      {dark ? <SunIcon /> : <MoonIcon />}
    </ActionIcon>
  );
};

const Explorer = ({ model }: { model: PageModel }): JSX.Element => {
  const { document, warnings } = model;
  const schemes = document.components.securitySchemes ?? {};
  const [auth, setAuthState] = useState<AuthState>(loadAuth);
  const [dialog, setDialog] = useState(false);
  const [query, setQuery] = useState('');

  const setAuth = (next: AuthState): void => {
    setAuthState(next);
    saveAuth(next);
  };

  const groups = useMemo(
    () =>
      groupByTag(entriesOf(document).filter((entry) => matches(entry, query))),
    [document, query],
  );
  const held = configured(schemes, auth);
  const tagProse = new Map(
    (document.tags ?? []).map((tag) => [
      tag.name,
      model.prose[`tag:${tag.name}`],
    ]),
  );

  return (
    <Container size="lg" py="xl">
      <Stack gap="lg">
        <Group justify="space-between" align="flex-start" wrap="nowrap">
          <Stack gap={6}>
            <Title order={1} fz="1.7rem">
              {document.info.title}
            </Title>
            <Group gap="xs">
              <Badge variant="light" color="gray">
                OpenAPI {document.openapi}
              </Badge>
              <Badge variant="light" color="gray">
                v{document.info.version}
              </Badge>
              {(document.servers ?? []).map((server) => (
                <Badge
                  key={server.url}
                  variant="outline"
                  color="gray"
                  ff="monospace"
                >
                  {server.url}
                </Badge>
              ))}
              <Anchor href={model.jsonHref} fz="sm">
                openapi.json
              </Anchor>
            </Group>
          </Stack>
          <Group gap="xs" wrap="nowrap">
            <Button
              variant={held.length > 0 ? 'filled' : 'default'}
              size="sm"
              leftSection={<LockIcon />}
              onClick={() => setDialog(true)}
            >
              Authorize{held.length > 0 ? ` (${held.length})` : ''}
            </Button>
            <ColorSchemeToggle />
          </Group>
        </Group>

        <Prose html={model.prose['info']} />

        {warnings.length > 0 && (
          <Alert color="orange" title="Generated with warnings">
            <List size="sm">
              {warnings.map((line) => (
                <List.Item key={line}>{line}</List.Item>
              ))}
            </List>
          </Alert>
        )}

        <TextInput
          placeholder="Filter by path, method, tag or operationId"
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
          data-filter
        />

        {groups.length === 0 && (
          <Text c="dimmed" fz="sm">
            No operation matches <Code>{query}</Code>.
          </Text>
        )}

        {groups.map(([tag, entries]) => (
          <Stack key={tag} gap="xs">
            <Title order={2} fz="1rem" tt="uppercase" c="dimmed" lts=".07em">
              {tag}
            </Title>
            <Prose html={tagProse.get(tag)} />
            <Accordion variant="separated" chevronPosition="left" multiple>
              {entries.map((entry) => (
                <Operation
                  key={`${entry.method}:${entry.path}`}
                  entry={entry}
                  model={model}
                  auth={auth}
                />
              ))}
            </Accordion>
          </Stack>
        ))}

        {Object.keys(document.components.schemas).length > 0 && (
          <Stack gap="xs">
            <Title order={2} fz="1rem" tt="uppercase" c="dimmed" lts=".07em">
              Schemas
            </Title>
            <Accordion variant="separated" chevronPosition="left" multiple>
              {Object.entries(document.components.schemas).map(
                ([name, schema]) => (
                  <Accordion.Item key={name} value={name} data-schema={name}>
                    <Accordion.Control>
                      <Text ff="monospace" fz="sm" fw={600}>
                        {name}
                      </Text>
                    </Accordion.Control>
                    <Accordion.Panel>
                      <SchemaView
                        schema={schema}
                        schemas={document.components.schemas}
                      />
                    </Accordion.Panel>
                  </Accordion.Item>
                ),
              )}
            </Accordion>
          </Stack>
        )}

        <Paper withBorder p="xs" radius="sm">
          <Text fz="xs" c="dimmed" ta="center">
            Served inline by @dunx/openapi - this page fetches nothing it was
            not given.
          </Text>
        </Paper>
      </Stack>

      <AuthDialog
        opened={dialog}
        onClose={() => setDialog(false)}
        schemes={schemes}
        state={auth}
        onChange={setAuth}
      />
    </Container>
  );
};

export const App = ({ model }: { model: PageModel }): JSX.Element => (
  <MantineProvider theme={theme} defaultColorScheme="auto">
    <Explorer model={model} />
  </MantineProvider>
);
