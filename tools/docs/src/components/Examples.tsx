import {
  Anchor,
  Badge,
  Card,
  Container,
  Group,
  SimpleGrid,
  Stack,
  Text,
  Title,
} from '@mantine/core';
import { site } from '../data';

interface Example {
  readonly dir: string;
  readonly title: string;
  readonly blurb: string;
  readonly run: string;
  readonly tags: readonly string[];
}

/**
 * A ladder rather than a gallery: each of these is a rung between "what does the
 * code look like" and "how does all of it fit together", and the order is the
 * order to read them in.
 */
const EXAMPLES: readonly Example[] = [
  {
    dir: 'minimal',
    title: 'minimal',
    blurb:
      'Five files and nothing else - a service, a controller, a module, HttpFactory.create and the one preload line. Its whole value is being small enough to read in two minutes.',
    run: 'bun run start',
    tags: ['start here'],
  },
  {
    dir: 'databases',
    title: 'databases',
    blurb:
      'The same repository code against four configurations: SQLite in async and in synchronous mode, Postgres over drizzle-orm/bun-sql, and MySQL over drizzle-orm/mysql-proxy with Bun.SQL as the transport. Anything without a server running reports that it is skipping.',
    run: 'bun run start',
    tags: ['sqlite', 'postgres', 'mysql'],
  },
  {
    dir: 'testing',
    title: 'testing',
    blurb:
      'createTestApp with providers replaced in place, createTestServer on a real Bun.serve at port 0, RecordingLogger, and a guard exercised through the actual request path rather than called directly.',
    run: 'bun test',
    tags: ['@dunx/testing'],
  },
  {
    dir: 'full',
    title: 'full',
    blurb:
      'One long-running service that exercises everything at once - DI, config, logging, routes, websocket gateways, guards, database, redis, queues, files, images, auth and OpenAPI. This is the one to open in a browser.',
    run: 'bun run start',
    tags: ['everything'],
  },
];

export const Examples = (): React.JSX.Element => (
  <Container size="lg" component="section">
    <Stack gap="xl">
      <Stack gap={6}>
        <Title order={2} size="h2">
          Examples
        </Title>
        <Text c="dimmed" maw={640}>
          Four runnable apps in the repository, in the order worth reading them.
          Every one of them is booted by CI, which is the only reason to trust
          that they still work.
        </Text>
      </Stack>

      <SimpleGrid cols={{ base: 1, md: 2 }} spacing="md">
        {EXAMPLES.map((example) => (
          <Card
            key={example.dir}
            withBorder
            radius="md"
            padding="lg"
            className="feature"
          >
            <Stack gap="xs" h="100%">
              <Group justify="space-between" wrap="nowrap">
                <Anchor
                  href={`${site.repoUrl}/tree/main/examples/${example.dir}`}
                  target="_blank"
                  rel="noreferrer"
                  fw={700}
                  ff="monospace"
                  size="sm"
                >
                  examples/{example.title}
                </Anchor>
                <Group gap={4}>
                  {example.tags.map((tag) => (
                    <Badge key={tag} size="xs" variant="light" tt="none">
                      {tag}
                    </Badge>
                  ))}
                </Group>
              </Group>
              <Text size="sm" c="dimmed">
                {example.blurb}
              </Text>
              <pre
                className="win-body"
                style={{ padding: 0, marginTop: 'auto' }}
              >
                <code>{example.run}</code>
              </pre>
            </Stack>
          </Card>
        ))}
      </SimpleGrid>
    </Stack>
  </Container>
);
