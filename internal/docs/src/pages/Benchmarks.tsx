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

const BENCH_README = 'blob/main/internal/bench/README.md';

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

/**
 * The three facts a reader needs to read the tables honestly. The long-form
 * methodology - the load generator's limitations, the handicaps in both
 * directions, the self-regressions the harness caught - lives in the repository,
 * not on a page someone opens to compare two frameworks.
 */
const Method = (): React.JSX.Element => (
  <Alert variant="light" color="yellow" title="How to read this">
    <List size="sm" spacing={6}>
      <List.Item>
        <b>Compare within a runtime first.</b> A Bun subject beating a Node one
        is a statement about Bun rather than about the framework, so the colour
        below encodes the runtime and the same Hono application is measured on
        both.
      </List.Item>
      <List.Item>
        <b>A gap under {NOISE_PCT} points is noise</b> on this setup, and a
        figure at or above 100% of raw <code>Bun.serve</code> is noise too: dunx
        dispatches through that API and cannot outrun it.
      </List.Item>
      <List.Item>
        <b>No database, cache or upstream call is involved</b>, and every
        subject validates with zod. In an application that talks to Postgres,
        every difference here is rounding error next to one query.
      </List.Item>
    </List>
    <Text size="sm" mt="sm">
      Full methodology, every subject&apos;s entry point and the harness itself:{' '}
      <Anchor href={`${site.repoUrl}/${BENCH_README}`} target="_blank">
        internal/bench
      </Anchor>
      .
    </Text>
  </Alert>
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
            writes <code>internal/bench/results/latest.json</code>, then rebuild
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
            layer on that exact API, so the gap is dunx&apos;s own overhead.
            Rows are ordered by measured throughput, losses included, and
            request logging gets its own row rather than being folded into the
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
        <Method />

        <RuntimeLegend
          runtimes={model.subjects.map((subject) => subject.runtime)}
        />

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
      </Stack>
    </Container>
  );
};
