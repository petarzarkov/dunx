import {
  Anchor,
  Badge,
  Container,
  Group,
  Stack,
  Text,
  Title,
} from '@mantine/core';
import { decimal, headlineSpeed, integer, throughputRows } from '../bench';
import { bench } from '../data';
import { href, RouteKind } from '../router';

const SCENARIO = 'plaintext';

/**
 * The "N times faster than X" panel, with every figure read off the generated
 * benchmark model so a rerun moves it and nothing here can go stale.
 *
 * The caveat sits inside the panel rather than under a fold, and it is not
 * decoration. dunx runs on Bun and the subjects in the headline run on Node, so
 * the multiple is a runtime difference and a framework difference multiplied
 * together. `headlineSpeed` reports that as `crossesRuntime` rather than leaving
 * the component to remember it.
 */
export const SpeedPanel = (): React.JSX.Element | null => {
  if (!bench) return null;
  const speed = headlineSpeed(bench, SCENARIO);
  if (!speed || speed.headline.length === 0) return null;

  const max = Math.max(
    ...speed.multiples.map((entry) => entry.rps),
    speed.focusRps,
  );

  // Derived, not written down: the framework's own cost is the gap to the raw
  // baseline, and quoting it as a literal is how a caveat goes stale.
  const ownCost =
    100 -
    (throughputRows(bench, SCENARIO).find((row) => row.id === 'dunx')
      ?.pctOfBaseline ?? 100);

  return (
    <Container size="lg" component="section">
      <Stack gap="xl">
        <Stack gap={6}>
          <Title order={2} size="h2">
            How much faster
          </Title>
          <Text c="dimmed" maw={640}>
            Plain text, {integer(speed.focusRps)} req/s, measured on one machine
            with the load generator sharing its cores. A relative ranking, not a
            capacity number.
          </Text>
        </Stack>

        <div className="speed">
          <div className="speed-headlines">
            {speed.headline.map((entry) => (
              <div key={entry.id}>
                <div className="speed-multiple gradient-text">
                  {decimal(entry.times, 1)}x
                </div>
                <Text size="sm" c="dimmed">
                  faster than {entry.label}
                </Text>
              </div>
            ))}
          </div>

          <div className="speed-bars">
            <div className="speed-row" data-focus="true">
              <Text size="sm" fw={700} ff="monospace" className="speed-name">
                @dunx/http
              </Text>
              <div className="speed-track">
                <div
                  className="speed-fill"
                  data-runtime="bun"
                  style={{ width: '100%' }}
                />
              </div>
              <Text size="sm" fw={700} className="speed-value">
                {integer(speed.focusRps)}
              </Text>
            </div>

            {speed.multiples.map((entry) => (
              <div className="speed-row" key={entry.id}>
                <Text size="sm" c="dimmed" className="speed-name">
                  {entry.label}
                </Text>
                <div className="speed-track">
                  <div
                    className="speed-fill"
                    data-runtime={entry.runtime}
                    style={{ width: `${(entry.rps / max) * 100}%` }}
                  />
                </div>
                <Text size="sm" c="dimmed" className="speed-value">
                  {integer(entry.rps)}
                </Text>
              </div>
            ))}
          </div>
        </div>

        <Group gap="xs" align="flex-start" wrap="nowrap">
          <Badge size="sm" variant="light" color="cyan" tt="none">
            read this
          </Badge>
          <Text size="sm" c="dimmed" maw={720}>
            {speed.crossesRuntime
              ? `Colour is the runtime, and it is the point: dunx runs on Bun and every subject in the headline runs on Node, so each multiple is a runtime difference and a framework difference multiplied together. The comparisons that isolate the framework are the two DI subjects against their own adapters, and dunx against raw Bun.serve, where it costs ${decimal(ownCost, 1)}%.`
              : 'Colour is the runtime. A comparison across runtimes carries both a runtime and a framework difference.'}{' '}
            Every figure here is regenerated from a real run;{' '}
            <Anchor href={href(RouteKind.Bench)}>the full results</Anchor> carry
            the standard deviation and the scenarios dunx does not win.
          </Text>
        </Group>
      </Stack>
    </Container>
  );
};
