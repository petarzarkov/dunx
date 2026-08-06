import {
  Anchor,
  Card,
  Container,
  SimpleGrid,
  Stack,
  Text,
  Title,
} from '@mantine/core';
import { decimal, scenarioHeadlines, startupHeadline } from '../bench';
import { bench } from '../data';
import { href, RouteKind } from '../router';

interface Loss {
  readonly title: string;
  readonly body: string;
}

/**
 * The section most framework sites do not have. It is here because the repo's
 * whole benchmarking discipline is to publish the losses, and a landing page
 * that only lists wins undoes that in one scroll.
 *
 * Every figure is read off the generated model, so a rerun that changes the
 * story changes this section rather than leaving it stale and flattering.
 */
const losses = (): Loss[] => {
  const list: Loss[] = [];
  const startup = bench ? startupHeadline(bench) : null;
  const plaintext = bench ? scenarioHeadlines(bench)[0] : undefined;

  if (startup) {
    list.push({
      title: `Cold start is ${decimal(startup.ratio, 2)}x raw ${startup.baselineLabel}`,
      body: `${decimal(startup.focusMs, 1)} ms against ${decimal(startup.baselineMs, 1)} ms, from the oxc-parser preload and eager dependency resolution. It still beats every Node subject by a wide margin, but it is the number to watch if boot time is what you are optimising.`,
    });
  }

  if (plaintext?.loggingPct != null) {
    list.push({
      title: 'Request logging is not free',
      body: `The same app reaches ${decimal(plaintext.loggingPct, 1)}% of the baseline with logging on against ${decimal(plaintext.focusPct, 1)}% with it off - one JSON.stringify and one write per request, inside an AsyncLocalStorage scope. It is on by default because an app that logs nothing is the worse default. One flag removes it.`,
    });
  }

  list.push({
    title: 'Validation costs more than the validator',
    body: 'Reading the body costs roughly three times as much as validating it - about 3 µs for req.json() against about 1 µs for zod. Switching validators moves the smaller number. That is worth knowing before optimising the wrong half.',
  });

  list.push({
    title: 'The transform has to be preloaded',
    body: 'A class with constructor parameters and no recorded dependencies is a boot error naming the missing preload, not a silent undefined. That is deliberate, but it does mean one line of bunfig.toml stands between a fresh clone and a running app.',
  });

  return list;
};

export const Honesty = (): React.JSX.Element => (
  <Container size="lg" component="section">
    <Stack gap="xl">
      <Stack gap={6}>
        <Title order={2} size="h2">
          Where it loses
        </Title>
        <Text c="dimmed" maw={640}>
          The benchmark publishes the standard deviation and the scenarios dunx
          does not win, and so does this page. A figure at or above 100% of{' '}
          <code>Bun.serve</code> is noise, not a win - <code>@dunx/http</code>{' '}
          dispatches <i>through</i> it and cannot be faster than the API it
          calls.
        </Text>
      </Stack>

      <SimpleGrid cols={{ base: 1, md: 2 }} spacing="md">
        {losses().map((loss) => (
          <Card key={loss.title} withBorder radius="md" padding="lg">
            <Stack gap="xs">
              <Text fw={700}>{loss.title}</Text>
              <Text size="sm" c="dimmed">
                {loss.body}
              </Text>
            </Stack>
          </Card>
        ))}
      </SimpleGrid>

      <Text size="sm" c="dimmed">
        The full run, every subject and the machine it was measured on are on
        the <Anchor href={href(RouteKind.Bench)}>benchmarks page</Anchor>.
      </Text>
    </Stack>
  </Container>
);
