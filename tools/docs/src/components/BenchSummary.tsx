import { Badge, Button, Card, Group, Stack, Text } from '@mantine/core';
import { decimal, integer, scenarioHeadlines, startupHeadline } from '../bench';
import { bench } from '../data';
import { href, RouteKind } from '../router';

/**
 * The above-the-fold block on the landing page. It carries the headline
 * throughput, the rival that beats dunx, and the cold-start ratio in the same
 * breath — the losses are in the summary, not only on the full page.
 */
export const BenchSummary = (): React.JSX.Element | null => {
  if (!bench) return null;

  const scenarios = scenarioHeadlines(bench);
  const startup = startupHeadline(bench);
  if (scenarios.length === 0) return null;

  const pcts = scenarios.map((scenario) => scenario.focusPct);
  const behind = scenarios.filter((scenario) => !scenario.focusLeadsRival);
  const rivals = [...new Set(behind.map((scenario) => scenario.rivalLabel))];

  return (
    <Card withBorder radius="md" padding="lg">
      <Group justify="space-between" align="flex-start" wrap="wrap" mb="md">
        <Stack gap={2}>
          <Group gap="xs">
            <Badge variant="light">Benchmarks</Badge>
            <Text size="xs" c="dimmed">
              {new Date(bench.generatedAt).toUTCString()}
            </Text>
          </Group>
          <Text fw={700} fz={22}>
            {decimal(Math.min(...pcts), 1)}–{decimal(Math.max(...pcts), 1)}% of
            raw <code>Bun.serve</code>
          </Text>
          <Text size="sm" c="dimmed" maw={560}>
            <code>@dunx/http</code> is a layer over <code>Bun.serve</code>, so
            the gap to it is the framework&apos;s own overhead.
            {behind.length > 0 && (
              <>
                {' '}
                It is beaten by {rivals.join(' and ')} on {behind.length} of{' '}
                {scenarios.length} scenarios
                {startup &&
                  startup.ratio > 1 &&
                  `, and boots in ${decimal(startup.ratio, 1)}x the baseline's time`}
                .
              </>
            )}
          </Text>
        </Stack>
        <Button component="a" href={href(RouteKind.Bench)} variant="light">
          See the full results
        </Button>
      </Group>

      <Stack gap="xs">
        {scenarios.map((scenario) => (
          <Group key={scenario.id} gap="sm" wrap="nowrap">
            <Text size="xs" w={110} ff="monospace" truncate>
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
            <Text size="xs" w={64} ta="right" fw={600}>
              {decimal(scenario.focusPct, 1)}%
            </Text>
            <Text size="xs" w={80} ta="right" c="dimmed">
              {integer(scenario.focusRps)}/s
            </Text>
          </Group>
        ))}
        <Text size="xs" c="dimmed">
          Bar is <code>@dunx/http</code> as a fraction of raw{' '}
          <code>Bun.serve</code>; the tick marks where{' '}
          {rivals.join(' / ') || 'the fastest other framework'} landed.
          Closed-loop latency on a shared machine — read the caveats before
          quoting any of this.
        </Text>
      </Stack>
    </Card>
  );
};
