import {
  Anchor,
  Badge,
  Box,
  Button,
  Card,
  Container,
  Group,
  SimpleGrid,
  Stack,
  Text,
  Title,
} from '@mantine/core';
import { BenchSummary } from '../components/BenchSummary';
import { Examples } from '../components/Examples';
import { Features } from '../components/Features';
import { Highlighted } from '../components/Highlighted';
import { Hero } from '../components/Hero';
import { Honesty } from '../components/Honesty';
import { NoDecorators } from '../components/NoDecorators';
import { RequestFlow } from '../components/RequestFlow';
import { ShowMeTheCode } from '../components/ShowMeTheCode';
import { SpeedPanel } from '../components/SpeedPanel';
import { Stats } from '../components/Stats';
import { site } from '../data';
import { href, RouteKind } from '../router';

const npmUrl = (name: string): string =>
  `https://www.npmjs.com/package/${encodeURIComponent(name)}`;

const INTEGRATIONS = [
  { name: 'zod', role: 'validation' },
  { name: 'drizzle-orm', role: 'ORM and migrations' },
  { name: 'better-auth', role: 'authentication' },
  { name: 'bullmq', role: 'queues' },
];

const STEPS = [
  {
    title: 'Install the packages',
    body: 'The core, the HTTP layer and the transform. Everything else is opt-in.',
    id: 'step-install',
    code: 'bun add @dunx/core @dunx/http @dunx/transform',
  },
  {
    title: 'Turn the transform on',
    body: 'One line, once per app. It is what lets constructors go unannotated.',
    id: 'step-preload',
    code: '# bunfig.toml\npreload = ["@dunx/transform/preload"]',
  },
  {
    title: 'Boot the server',
    body: 'Bun.serve underneath, with request logging already on.',
    id: 'step-boot',
    code: 'await (await HttpFactory.create(AppModule)).listen(3000);',
  },
];

/**
 * A strip rather than a section: these are other people's libraries, and the
 * point being made is that dunx does not compete with them.
 */
const Integrations = (): React.JSX.Element => (
  <Container size="lg" component="section">
    <Stack gap="md">
      <Stack gap={6}>
        <Title order={2} size="h2">
          It does not reinvent your libraries
        </Title>
        <Text c="dimmed" maw={640}>
          Where Bun ships no primitive for a hard problem, dunx integrates the
          best-in-class library instead of competing with it. All four are peer
          dependencies - you install them and own the version.
        </Text>
      </Stack>
      <Group gap="sm">
        {INTEGRATIONS.map((item) => (
          <div key={item.name} className="integration">
            <Text span fw={700} ff="monospace" size="sm">
              {item.name}
            </Text>
            <Text span c="dimmed" size="xs">
              {item.role}
            </Text>
          </div>
        ))}
      </Group>
      <Text size="sm" c="dimmed">
        There is no dunx ORM, no dunx validator, no dunx auth flow and no dunx
        job queue. Where a library offers a Bun-native driver, that driver is
        mandatory - <code>drizzle-orm/bun-sqlite</code> and{' '}
        <code>drizzle-orm/bun-sql</code>, never <code>pg</code> or{' '}
        <code>better-sqlite3</code>.
      </Text>
    </Stack>
  </Container>
);

const GetStarted = (): React.JSX.Element => (
  <Container size="lg" component="section">
    <Stack gap="xl">
      <Stack gap={6}>
        <Title order={2} size="h2">
          Three steps to a running app
        </Title>
        <Text c="dimmed" maw={640}>
          No CLI to install, no scaffold to generate, no decorator metadata to
          configure.
        </Text>
      </Stack>

      <SimpleGrid cols={{ base: 1, md: 3 }} spacing="md">
        {STEPS.map((step, index) => (
          <Card key={step.title} withBorder radius="md" padding="lg">
            <Stack gap="sm" h="100%">
              <Group gap="sm" wrap="nowrap">
                <span className="step-number">{index + 1}</span>
                <Text fw={700}>{step.title}</Text>
              </Group>
              <Text size="sm" c="dimmed">
                {step.body}
              </Text>
              <Highlighted id={step.id} fallback={step.code} />
            </Stack>
          </Card>
        ))}
      </SimpleGrid>

      <Group>
        <Button
          component="a"
          href={href(RouteKind.Guide, 'migration-from-nest')}
          variant="default"
        >
          Coming from NestJS?
        </Button>
        <Button
          component="a"
          href={href(RouteKind.Guide, 'architecture')}
          variant="subtle"
        >
          Read the architecture
        </Button>
      </Group>
    </Stack>
  </Container>
);

const Packages = (): React.JSX.Element => (
  <Container size="lg" component="section">
    <Stack gap="xl">
      <Stack gap={6}>
        <Title order={2} size="h2">
          The packages
        </Title>
        <Text c="dimmed" maw={640}>
          Seven, and only <code>@dunx/core</code> plus <code>@dunx/http</code>{' '}
          are needed to serve a request.
        </Text>
      </Stack>

      <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }} spacing="md">
        {site.packages.map((pkg) => (
          <Card
            key={pkg.name}
            withBorder
            radius="md"
            padding="md"
            className="feature"
          >
            <Stack gap="xs" h="100%">
              <Group justify="space-between" wrap="nowrap">
                <Anchor
                  href={href(RouteKind.Api, pkg.dir)}
                  fw={700}
                  ff="monospace"
                  size="sm"
                >
                  {pkg.name}
                </Anchor>
                <Badge size="xs" variant="default">
                  {pkg.symbols.filter((s) => s.subpaths.length > 0).length}{' '}
                  exports
                </Badge>
              </Group>
              <Text size="sm" c="dimmed" lineClamp={4}>
                {pkg.description}
              </Text>
              <Group gap={4} mt="auto" justify="space-between">
                {/* `.` is every package's root export and says nothing; only
                    the extra subpaths are worth a badge. */}
                <Group gap={4}>
                  {pkg.subpaths
                    .filter((subpath) => subpath !== '.')
                    .map((subpath) => (
                      <Badge
                        key={subpath}
                        size="xs"
                        variant="light"
                        color="gray"
                        tt="none"
                      >
                        {subpath}
                      </Badge>
                    ))}
                </Group>
                <Anchor
                  href={npmUrl(pkg.name)}
                  target="_blank"
                  size="xs"
                  c="dimmed"
                >
                  npm
                </Anchor>
              </Group>
            </Stack>
          </Card>
        ))}
      </SimpleGrid>
    </Stack>
  </Container>
);

export const Home = (): React.JSX.Element => (
  <Box className="landing">
    <Hero />
    {/* First content section on purpose: "how much faster" is what a reader came
        for, and burying it under the feature grid answered a question nobody had
        asked yet. */}
    <div className="speed-lead">
      <SpeedPanel />
    </div>
    <Stats />
    <div className="landing-sections">
      <Features />
      <Container size="lg" component="section">
        <NoDecorators />
      </Container>
      <ShowMeTheCode />
      <RequestFlow />
      <Container size="lg" component="section">
        <BenchSummary />
      </Container>
      <Honesty />
      <Integrations />
      <Examples />
      <Packages />
      <GetStarted />
    </div>
  </Box>
);
