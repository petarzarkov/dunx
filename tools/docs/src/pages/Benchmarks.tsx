import {
  Alert,
  Anchor,
  Badge,
  Card,
  Container,
  Group,
  List,
  SimpleGrid,
  Stack,
  Table,
  Text,
  Title,
} from '@mantine/core';
import {
  configLine,
  decimal,
  integer,
  machineLine,
  NOISE_PCT,
  scenarioHeadlines,
  scoreboard,
  startupHeadline,
  startupRows,
  throughputRows,
  type Verdict,
} from '../bench';
import { StartupChart, ThroughputChart } from '../components/BenchChart';
import {
  RuntimeLegend,
  StartupTable,
  ThroughputTable,
} from '../components/BenchBars';
import { bench, site } from '../data';
import type { BenchModel } from '../../scripts/extract/model';

const BENCH_README = 'blob/main/tools/bench/README.md';

const Stat = ({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint: string;
}): React.JSX.Element => (
  <Card withBorder radius="md" padding="md">
    <Text size="xs" tt="uppercase" c="dimmed" fw={600}>
      {label}
    </Text>
    <Text fz={30} fw={700} lh={1.2}>
      {value}
    </Text>
    <Text size="xs" c="dimmed">
      {hint}
    </Text>
  </Card>
);

const Headlines = ({ model }: { model: BenchModel }): React.JSX.Element => {
  const scenarios = scenarioHeadlines(model);
  const startup = startupHeadline(model);
  const board = scoreboard(model);
  const pcts = scenarios.map((scenario) => scenario.focusPct);
  const rival = board.rivalLabel ?? 'the fastest rival';

  return (
    <SimpleGrid cols={{ base: 1, sm: 3 }}>
      <Stat
        label="dunx vs raw Bun.serve"
        value={
          pcts.length === 0
            ? '-'
            : `${decimal(Math.min(...pcts), 1)}-${decimal(Math.max(...pcts), 1)}%`
        }
        hint={`of the ceiling, across ${scenarios.length} scenarios. The rest is framework overhead.`}
      />
      <Stat
        label={`Against ${rival}`}
        value={`${board.ahead}W ${board.tied}T ${board.behind}L`}
        hint={`Won ${board.ahead}, tied ${board.tied}, lost ${board.behind} of ${board.total}. A gap inside ±${NOISE_PCT} points is a tie on this setup, not a result.`}
      />
      <Stat
        label="Cold start"
        value={startup ? `${decimal(startup.ratio, 2)}x` : '-'}
        hint={
          startup
            ? `${decimal(startup.focusMs, 1)} ms against ${startup.baselineLabel}'s ${decimal(startup.baselineMs, 1)} ms - rank ${startup.rank} of ${startup.total}. dunx's clearest loss on this page.`
            : 'No startup samples in this run.'
        }
      />
    </SimpleGrid>
  );
};

const VERDICT_COLOR: Record<Verdict, string> = {
  ahead: 'indigo',
  tied: 'gray',
  behind: 'orange',
};

/** One row per scenario: where dunx landed, and against whom. */
const Scoreboard = ({ model }: { model: BenchModel }): React.JSX.Element => (
  <Card withBorder radius="md" padding="md">
    <Title order={2} size="h4" mb="xs">
      Scenario by scenario
    </Title>
    <Table verticalSpacing="xs" fz="sm">
      <Table.Thead>
        <Table.Tr>
          <Table.Th>Scenario</Table.Th>
          <Table.Th ta="right" w={110}>
            dunx
          </Table.Th>
          <Table.Th ta="right" w={140}>
            Fastest rival
          </Table.Th>
          <Table.Th ta="right" w={90}>
            Rank
          </Table.Th>
          <Table.Th ta="right" w={90}>
            Verdict
          </Table.Th>
        </Table.Tr>
      </Table.Thead>
      <Table.Tbody>
        {scenarioHeadlines(model).map((scenario) => (
          <Table.Tr key={scenario.id}>
            <Table.Td>
              <Anchor href={`#/benchmarks?h=scenario-${scenario.id}`}>
                {scenario.title}
              </Anchor>
            </Table.Td>
            <Table.Td ta="right" fw={700}>
              {decimal(scenario.focusPct, 1)}%
            </Table.Td>
            <Table.Td ta="right" c="dimmed">
              {scenario.rivalLabel} {decimal(scenario.rivalPct, 1)}%
            </Table.Td>
            <Table.Td ta="right">
              {scenario.focusRank} / {scenario.subjectCount}
            </Table.Td>
            <Table.Td ta="right">
              <Badge
                size="sm"
                variant="light"
                color={VERDICT_COLOR[scenario.verdict]}
              >
                {scenario.verdict}
              </Badge>
            </Table.Td>
          </Table.Tr>
        ))}
      </Table.Tbody>
    </Table>
  </Card>
);

const Losses = ({ model }: { model: BenchModel }): React.JSX.Element | null => {
  const scenarios = scenarioHeadlines(model);
  const startup = startupHeadline(model);
  const behind = scenarios.filter((scenario) => !scenario.focusLeadsRival);

  if (behind.length === 0 && !startup) return null;

  return (
    <Card withBorder radius="md" padding="md">
      <Title order={2} size="h4" mb="xs">
        Where dunx loses
      </Title>
      <List size="sm" spacing={6}>
        {behind.map((scenario) => (
          <List.Item key={scenario.id}>
            <b>{scenario.title}</b> - {scenario.rivalLabel} reaches{' '}
            {decimal(scenario.rivalPct, 1)}% of raw <code>Bun.serve</code>, dunx{' '}
            {decimal(scenario.focusPct, 1)}%. dunx places {scenario.focusRank}{' '}
            of {scenario.subjectCount}.
          </List.Item>
        ))}
        {startup && startup.ratio > 1 && (
          <List.Item>
            <b>Cold start</b> - {decimal(startup.focusMs, 1)} ms against{' '}
            {startup.baselineLabel}&apos;s {decimal(startup.baselineMs, 1)} ms,
            roughly {decimal(startup.ratio, 1)}x. That is the compiler preload
            parsing every loaded module plus eager DI resolution and route
            discovery - paid once at boot, and a real cost on a short-lived
            process.
          </List.Item>
        )}
        <List.Item>
          A gap under {NOISE_PCT} points is noise on this setup - that is why
          the scoreboard above reads some of these as ties. The rest are wider
          than that and are real.
        </List.Item>
      </List>
    </Card>
  );
};

const Caveats = ({ model }: { model: BenchModel }): React.JSX.Element => (
  <Alert variant="light" color="yellow" title="How these were measured">
    <List size="sm" spacing={6}>
      <List.Item>
        Load generator: <code>{model.loadGenerator.version}</code> (
        {model.loadGenerator.id}).
      </List.Item>
      {model.loadGenerator.limitations.map((limitation) => (
        <List.Item key={limitation}>{limitation}</List.Item>
      ))}
      <List.Item>
        No database, cache, filesystem or upstream call is involved. In an
        application that talks to Postgres, every difference on this page is
        rounding error next to one query.
      </List.Item>
      <List.Item>
        Every subject validates with zod, including Fastify and Elysia, which
        ship faster compiled validators. That holds the validator constant and
        understates both of them on <code>validate</code>.
      </List.Item>
      <List.Item>
        Single process, single thread, no <code>reusePort</code>, no cluster.
        Standard deviation is across whole runs, not within one.
      </List.Item>
      <List.Item>
        Compare within a runtime first. A Bun subject beating a Node one is a
        statement about Bun, not about the framework - which is why the same
        Hono application is measured on both, and why the colour below encodes
        the runtime.
      </List.Item>
    </List>
    <Text size="sm" mt="sm">
      The full methodology, including every handicap in both directions, is in{' '}
      <Anchor href={`${site.repoUrl}/${BENCH_README}`} target="_blank">
        tools/bench/README.md
      </Anchor>
      .
    </Text>
  </Alert>
);

const Subjects = ({ model }: { model: BenchModel }): React.JSX.Element => (
  <Card withBorder radius="md" padding="md">
    <Title order={2} size="h4" mb="xs">
      Subjects, versions and handicaps
    </Title>
    <Table.ScrollContainer minWidth={720}>
      <Table verticalSpacing="xs" fz="xs">
        <Table.Thead>
          <Table.Tr>
            <Table.Th w={140}>Subject</Table.Th>
            <Table.Th w={70}>Runtime</Table.Th>
            <Table.Th w={90}>Version</Table.Th>
            <Table.Th w={150}>Validator</Table.Th>
            <Table.Th>Notes</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {model.subjects.map((subject) => (
            <Table.Tr key={subject.id}>
              <Table.Td ff="monospace">{subject.label}</Table.Td>
              <Table.Td>
                <Badge size="xs" variant="light" color="gray">
                  {subject.runtime}
                </Badge>
              </Table.Td>
              <Table.Td ff="monospace">{subject.version}</Table.Td>
              <Table.Td>{subject.validator}</Table.Td>
              <Table.Td c="dimmed">{subject.notes.join(' ')}</Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Table.ScrollContainer>
  </Card>
);

export const Benchmarks = (): React.JSX.Element => {
  if (!bench) {
    return (
      <Container size="lg" py="xl">
        <Stack gap="sm">
          <Title order={1}>Benchmarks</Title>
          <Text c="dimmed">
            No benchmark run in this build. Produce one with{' '}
            <code>bun run --filter &apos;@dunx/bench&apos; start</code>, which
            writes <code>tools/bench/results/latest.json</code>, then rebuild
            the site.
          </Text>
        </Stack>
      </Container>
    );
  }

  const model = bench;
  const totalBad = model.results.reduce((sum, result) => sum + result.bad, 0);

  return (
    <Container size="lg" py="xl">
      <Stack gap="xl">
        <Stack gap="xs">
          <Title order={1}>Benchmarks</Title>
          <Text c="dimmed" maw={760}>
            <code>@dunx/http</code> against raw <code>Bun.serve</code>, Elysia,
            Hono, Fastify, Express and bare <code>node:http</code>. The number
            worth having is the gap to raw <code>Bun.serve</code>: dunx is a
            layer on that exact API, so the gap is dunx&apos;s own overhead and
            nothing else. Rows are ordered by measured throughput, losses
            included, and request logging - which is on by default and which no
            other subject does - is its own row rather than folded into the
            framework&apos;s number.
          </Text>
          <Text size="xs" c="dimmed" ff="monospace">
            {machineLine(model)}
          </Text>
          <Text size="xs" c="dimmed" ff="monospace">
            {configLine(model)}
          </Text>
          <Group gap="xs">
            <Badge variant="default" size="sm">
              {new Date(model.generatedAt).toUTCString()}
            </Badge>
            <Badge
              variant="light"
              size="sm"
              color={totalBad === 0 ? 'green' : 'red'}
            >
              {totalBad === 0
                ? 'zero errors, zero non-2xx'
                : `${integer(totalBad)} bad responses`}
            </Badge>
          </Group>
        </Stack>

        <Headlines model={model} />
        <Scoreboard model={model} />
        <Losses model={model} />
        <Caveats model={model} />

        <RuntimeLegend />

        {model.scenarios.map((scenario) => (
          <Stack key={scenario.id} gap="xs" id={`scenario-${scenario.id}`}>
            <Group gap="sm" align="baseline">
              <Title order={2} size="h3">
                {scenario.title}
              </Title>
              <Text size="sm" c="dimmed" ff="monospace">
                {scenario.method} {scenario.path}
              </Text>
            </Group>
            <Text size="sm" c="dimmed">
              {scenario.description}
            </Text>
            <ThroughputChart rows={throughputRows(model, scenario.id)} />
            <ThroughputTable rows={throughputRows(model, scenario.id)} />
          </Stack>
        ))}

        <Stack gap="xs">
          <Title order={2} size="h3">
            Cold start
          </Title>
          <Text size="sm" c="dimmed">
            Process spawn to first served request, median of{' '}
            {model.config.startupSamples} samples. Polled at about 1 ms, so
            treat anything under 5 ms as a tie.
          </Text>
          <StartupChart rows={startupRows(model)} />
          <StartupTable rows={startupRows(model)} />
        </Stack>

        <Subjects model={model} />
      </Stack>
    </Container>
  );
};
