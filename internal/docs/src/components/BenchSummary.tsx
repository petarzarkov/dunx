import { Badge, Button, Card, Group, Stack, Text } from '@mantine/core';
import {
  decimal,
  integer,
  NOISE_PCT,
  scenarioHeadlines,
  scoreboard,
  startupHeadline,
  Verdict,
} from '../bench';
import { bench } from '../data';
import { href, RouteKind } from '../router';

const VERDICT_COLOR: Record<Verdict, string> = {
  ahead: 'indigo',
  tied: 'gray',
  behind: 'orange',
};

const VERDICT_LABEL: Record<Verdict, string> = {
  ahead: 'ahead',
  tied: 'tied',
  behind: 'behind',
};

/**
 * The above-the-fold block on the landing page. It carries the headline
 * throughput, the verdict against the fastest rival, and the cold-start ratio
 * in the same breath - the losses are in the summary, not only on the full
 * page. Every sentence is computed, so a rerun that turns a win into a tie
 * rewrites this card rather than leaving it lying.
 */
export const BenchSummary = (): React.JSX.Element | null => {
  if (!bench) return null;

  const scenarios = scenarioHeadlines(bench);
  const startup = startupHeadline(bench);
  const board = scoreboard(bench);
  if (scenarios.length === 0) return null;

  const pcts = scenarios.map((scenario) => scenario.focusPct);
  const rival = board.rivalLabel ?? 'the fastest other framework';

  return (
    <Card withBorder radius="md" padding="lg">
      <Group justify="space-between" align="flex-start" wrap="wrap" mb="md">
        <Stack gap={4}>
          <Group gap="xs">
            <Badge variant="light">Measured</Badge>
            <Text size="xs" c="dimmed">
              {new Date(bench.generatedAt).toUTCString()}
            </Text>
          </Group>
          <Text fw={700} fz={28} lh={1.2}>
            {decimal(Math.min(...pcts), 1)}-{decimal(Math.max(...pcts), 1)}% of
            raw <code>Bun.serve</code>
          </Text>
          <Text size="sm" c="dimmed" maw={620}>
            across {scenarios.length} scenarios. <code>@dunx/http</code> is a
            layer over <code>Bun.serve</code>, so the gap to it is the
            framework&apos;s own overhead and nothing else. Against {rival}:{' '}
            <b>
              {board.ahead} ahead, {board.tied} tied, {board.behind} behind
            </b>{' '}
            - tied meaning inside the ±{NOISE_PCT} point run-to-run band.
            {startup &&
              startup.ratio > 1 &&
              ` It boots in ${decimal(startup.ratio, 1)}x the baseline's time, which is the loss.`}
          </Text>
        </Stack>
        <Button component="a" href={href(RouteKind.Bench)} variant="light">
          See the full results
        </Button>
      </Group>

      <Stack gap="xs">
        {scenarios.map((scenario) => (
          <Group key={scenario.id} gap="sm" wrap="nowrap">
            <Text size="xs" w={92} ff="monospace" truncate>
              {scenario.id}
            </Text>
            <div className="bench-track">
              <div
                className="bench-fill"
                data-runtime="bun"
                style={{ width: `${Math.min(100, scenario.focusPct)}%` }}
              />
              <div
                className="bench-marker"
                style={{ left: `${Math.min(100, scenario.rivalPct)}%` }}
                title={`${scenario.rivalLabel} ${decimal(scenario.rivalPct, 1)}%`}
              />
            </div>
            <Text size="xs" w={56} ta="right" fw={600}>
              {decimal(scenario.focusPct, 1)}%
            </Text>
            <Text size="xs" w={76} ta="right" c="dimmed">
              {integer(scenario.focusRps)}/s
            </Text>
            <Badge
              size="xs"
              w={62}
              variant="light"
              color={VERDICT_COLOR[scenario.verdict]}
            >
              {VERDICT_LABEL[scenario.verdict]}
            </Badge>
          </Group>
        ))}
        <Text size="xs" c="dimmed">
          Bar is <code>@dunx/http</code> as a fraction of raw{' '}
          <code>Bun.serve</code>; the tick marks where {rival} landed.
          Closed-loop latency on one shared machine - read the caveats before
          quoting any of this.
        </Text>
      </Stack>
    </Card>
  );
};
