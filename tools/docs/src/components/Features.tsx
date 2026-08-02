import {
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
import { bench, site } from '../data';

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

/** Inline paths rather than an icon package — nine strokes are not a dependency. */
const PATHS = Object.freeze({
  inject: 'M12 3v18M5 8l7-5 7 5M5 16l7 5 7-5',
  bolt: 'M13 2 4 14h7l-1 8 9-12h-7z',
  log: 'M4 6h16M4 12h10M4 18h13',
  layers: 'M12 3 3 8l9 5 9-5-9-5ZM3 14l9 5 9-5',
  spec: 'M7 3h7l5 5v13H7zM14 3v5h5M10 13h6M10 17h6',
  flask: 'M10 3v6L5 19a2 2 0 0 0 2 3h10a2 2 0 0 0 2-3l-5-10V3M9 3h6',
});

const Icon = ({ d }: { d: string }): React.JSX.Element => (
  <span className="feature-icon" aria-hidden="true">
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={d} />
    </svg>
  </span>
);

const Feature = ({
  icon,
  title,
  children,
}: {
  icon: string;
  title: string;
  children: React.ReactNode;
}): React.JSX.Element => (
  <Card withBorder radius="md" padding="lg" className="feature">
    <Stack gap="sm">
      <Icon d={icon} />
      <Text fw={700}>{title}</Text>
      <Text size="sm" c="dimmed">
        {children}
      </Text>
    </Stack>
  </Card>
);

export const Features = (): React.JSX.Element => {
  const plaintext = bench ? scenarioHeadlines(bench)[0] : undefined;

  return (
    <Container size="lg" component="section">
      <Stack gap="xl">
        <Stack gap={6}>
          <Title order={2} size="h2">
            What is actually different
          </Title>
          <Text c="dimmed" maw={640}>
            Every claim here is checkable somewhere else on this site, and the
            one that costs something says what it costs.
          </Text>
        </Stack>

        <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }} spacing="md">
          <Feature icon={PATHS.inject} title="Injection without annotation">
            <code>@dunx/compiler</code> reads constructor parameter types at
            load time and records them as a thunk, so a dependency declared
            later in the file — or across a circular import — resolves with no{' '}
            <code>forwardRef</code>. An erased type is a boot error naming the
            parameter, not a silent <code>undefined</code>.
          </Feature>

          <Feature icon={PATHS.bolt} title="A core with zero dependencies">
            The container, modules, lifecycle, configuration and the{' '}
            <code>Logger</code> and <code>RequestContext</code> contracts, with
            nothing behind them. That is what lets <code>@dunx/http</code> log
            every request in an app that imported no logging module at all.
          </Feature>

          <Feature icon={PATHS.log} title="One log line per request">
            On by default, outermost in the chain, carrying request and response
            in a single entry — 4xx at <code>warn</code>, 5xx at{' '}
            <code>error</code>, unmatched paths included. Nest needs a
            middleware plus an interceptor; middleware here wraps{' '}
            <code>next()</code>.
            {plaintext?.loggingPct != null && (
              <>
                {' '}
                It is not free and the benchmark gives it its own row:{' '}
                <b>{decimal(plaintext.loggingPct, 1)}%</b> of the baseline with
                it on against <b>{decimal(plaintext.focusPct, 1)}%</b> with it
                off.
              </>
            )}
          </Feature>

          <Feature icon={PATHS.layers} title="Bun-native all the way down">
            No <code>express</code>, no <code>ws</code>, no <code>ioredis</code>
            , no <code>pg</code>, no <code>sharp</code>, no <code>dotenv</code>.
            Routing is <code>Bun.serve</code>&apos;s own router — path params
            and per-method dispatch in Zig, not a JavaScript router.
            <Group gap={5} mt="xs">
              {BUN_APIS.map((api) => (
                <Code key={api}>{api}</Code>
              ))}
            </Group>
          </Feature>

          <Feature icon={PATHS.spec} title="OpenAPI from the schemas you have">
            Routes validate against Standard Schema, so zod, Valibot and ArkType
            all work. <code>@dunx/openapi</code> turns those same schemas into
            an OpenAPI 3.1 document and a self-contained page that makes every
            route testable — no CDN, no external request.
          </Feature>

          <Feature icon={PATHS.flask} title="Tests against a real server">
            <code>createTestApp</code> replaces providers in place;{' '}
            <code>createTestServer</code> boots a real <code>Bun.serve</code> on
            port 0. No mocked HTTP layer, because the routing being tested is
            Bun&apos;s.
          </Feature>
        </SimpleGrid>

        <Text size="sm" c="dimmed">
          {site.packages.length} packages, deliberately few — merging is nearly
          free because ESM tree-shaking drops what is not imported.
        </Text>
      </Stack>
    </Container>
  );
};
