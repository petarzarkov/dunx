import {
  Anchor,
  Badge,
  Button,
  Card,
  Code,
  Container,
  Group,
  SimpleGrid,
  Stack,
  Text,
  Title,
} from '@mantine/core';
import { decimal, scenarioHeadlines } from '../bench';
import { BenchSummary } from '../components/BenchSummary';
import { NoDecorators } from '../components/NoDecorators';
import { Prose } from '../components/Prose';
import { bench, site } from '../data';
import { href, RouteKind } from '../router';

const BUN_APIS = [
  'Bun.serve',
  'bun:sqlite',
  'Bun.SQL',
  'Bun.RedisClient',
  'Bun.Image',
  'Bun.S3Client',
  'Bun.password',
  'Bun.file',
  'Bun.Glob',
];

const npmUrl = (name: string): string =>
  `https://www.npmjs.com/package/${encodeURIComponent(name)}`;

const publicExports = (): number =>
  site.packages.reduce(
    (sum, pkg) => sum + pkg.symbols.filter((s) => s.subpaths.length > 0).length,
    0,
  );

const Hero = (): React.JSX.Element => (
  <Stack gap="sm">
    <Group gap={6}>
      <Badge variant="light" size="lg" tt="none">
        Bun-native
      </Badge>
      <Badge variant="default" size="lg" tt="none">
        no reflect-metadata
      </Badge>
      <Badge variant="default" size="lg" tt="none">
        core has zero dependencies
      </Badge>
    </Group>
    <Title order={1} size={52} lh={1.05}>
      dunx
    </Title>
    <Text size="xl" c="dimmed" maw={680}>
      NestJS-shaped ergonomics, none of the NestJS runtime. A dependency
      injection framework built on Bun&apos;s own primitives — nothing the
      platform already ships is reimplemented in JavaScript, and nothing a
      mature library already solves is invented here.
    </Text>
    <Group mt={4}>
      <Button component="a" href={href(RouteKind.Bench)}>
        See the benchmarks
      </Button>
      <Button
        variant="default"
        component="a"
        href={href(RouteKind.Api, 'core')}
      >
        API reference
      </Button>
      <Button
        variant="default"
        component="a"
        href={href(RouteKind.Guide, 'architecture')}
      >
        Read the architecture
      </Button>
      <Button
        variant="subtle"
        component="a"
        href={site.repoUrl}
        target="_blank"
      >
        GitHub
      </Button>
    </Group>
  </Stack>
);

const Panel = ({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}): React.JSX.Element => (
  <Card withBorder radius="md" padding="md">
    <Stack gap="xs" h="100%">
      <Text fw={700}>{title}</Text>
      {children}
    </Stack>
  </Card>
);

/**
 * Four claims, each one checkable somewhere else on this site. The request
 * logging figure is read off the benchmark rather than described, because it is
 * the one claim here that costs something.
 */
const Distinctives = (): React.JSX.Element => {
  const plaintext = bench ? scenarioHeadlines(bench)[0] : undefined;

  return (
    <Stack gap="md">
      <Title order={2} size="h3">
        What is actually different
      </Title>
      <SimpleGrid cols={{ base: 1, md: 2 }} spacing="md">
        <Panel title="@dunx/core has zero dependencies">
          <Text size="sm" c="dimmed">
            The container, modules, lifecycle, configuration and the{' '}
            <code>Logger</code> and <code>RequestContext</code> contracts, with
            nothing behind them. That constraint is what lets{' '}
            <code>@dunx/http</code> log every request in an app that imported no
            logging module at all — the default writes one JSON line and the
            request context is <code>AsyncLocalStorage</code>.
          </Text>
        </Panel>

        <Panel title="Bun-native all the way down">
          <Text size="sm" c="dimmed">
            No <code>express</code>, no <code>ws</code>, no <code>ioredis</code>
            , no <code>pg</code>, no <code>sharp</code>, no <code>dotenv</code>,
            no <code>@aws-sdk/*</code>. Routing is <code>Bun.serve</code>
            &apos;s native router — path params and per-method dispatch in Zig,
            not a JavaScript router.
          </Text>
          <Group gap={6} mt={4}>
            {BUN_APIS.map((api) => (
              <Code key={api}>{api}</Code>
            ))}
          </Group>
        </Panel>

        <Panel title="One structured log line per request">
          <Text size="sm" c="dimmed">
            On by default, outermost in the chain, carrying the request and the
            response in a single entry — 4xx at <code>warn</code>, 5xx at{' '}
            <code>error</code>, unmatched paths included. Nest needs a
            middleware plus an interceptor for that; dunx does not, because
            middleware wraps <code>next()</code>.
          </Text>
          {plaintext?.loggingPct != null && (
            <Text size="sm" c="dimmed">
              It is not free, and the benchmark gives it its own row rather than
              folding it in: on {plaintext.title.toLowerCase()},{' '}
              <b>{decimal(plaintext.loggingPct, 1)}%</b> of raw{' '}
              <code>Bun.serve</code> with it on against{' '}
              <b>{decimal(plaintext.focusPct, 1)}%</b> with it off. One flag
              removes it.
            </Text>
          )}
        </Panel>

        <Panel
          title={`${site.packages.length} packages, ${publicExports()} public exports`}
        >
          <Text size="sm" c="dimmed">
            Deliberately few, because ESM tree-shaking drops what is not
            imported. Three of them are integrations rather than dunx code:{' '}
            <b>drizzle</b> over <code>bun:sqlite</code> and <code>Bun.SQL</code>
            , <b>better-auth</b> mounted on <code>Bun.serve</code>, and{' '}
            <b>bullmq</b> driven through <code>Bun.RedisClient</code>. There is
            no dunx ORM, no dunx validator and no dunx auth flow.
          </Text>
        </Panel>
      </SimpleGrid>
    </Stack>
  );
};

const Packages = (): React.JSX.Element => (
  <Stack gap="md">
    <Title order={2} size="h3">
      Packages
    </Title>
    <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }} spacing="md">
      {site.packages.map((pkg) => (
        <Card key={pkg.name} withBorder radius="md" padding="md">
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
              <Group gap={4}>
                {pkg.subpaths.map((subpath) => (
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
);

export const Home = (): React.JSX.Element => (
  <Container size="lg" py="xl">
    <Stack gap={48}>
      <Hero />
      <NoDecorators />
      <BenchSummary />
      <Distinctives />
      <Packages />

      <Stack gap="md">
        <Title order={2} size="h3">
          Overview
        </Title>
        <Prose html={site.home} />
        <Text size="xs" c="dimmed">
          Generated from{' '}
          <Anchor href={`${site.repoUrl}/blob/main/README.md`} target="_blank">
            README.md
          </Anchor>{' '}
          on {new Date(site.generatedAt).toUTCString()}
        </Text>
      </Stack>
    </Stack>
  </Container>
);
