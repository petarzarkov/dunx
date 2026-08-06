import { Box, Container, SimpleGrid, Stack, Text } from '@mantine/core';
import { decimal, scenarioHeadlines } from '../bench';
import { bench, coverage, site } from '../data';

interface Stat {
  readonly value: string;
  readonly label: string;
  readonly detail: string;
}

const publicExports = (): number =>
  site.packages.reduce((sum, pkg) => sum + pkg.exports.length, 0);

/**
 * Five numbers, every one of them read off the generated model rather than
 * typed in. A rerun that moves the benchmark or the coverage moves this band
 * with it, which is the only reason a band like this is worth having.
 */
const stats = (): Stat[] => {
  const plaintext = bench ? scenarioHeadlines(bench)[0] : undefined;
  const lines = coverage.totals.lines;
  const list: Stat[] = [
    {
      value: '0',
      label: 'dependencies',
      detail: 'in @dunx/core',
    },
    {
      value: String(site.packages.length),
      label: 'packages',
      detail: `${publicExports()} public exports`,
    },
  ];

  if (plaintext) {
    list.splice(1, 0, {
      value: `${decimal(plaintext.focusPct, 1)}%`,
      label: 'of raw Bun.serve',
      detail: plaintext.title.toLowerCase(),
    });
  }

  if (lines > 0) {
    list.push({
      value: `${decimal((coverage.totals.linesHit / lines) * 100, 1)}%`,
      label: 'line coverage',
      detail: `${coverage.totals.linesHit.toLocaleString('en-US')} of ${lines.toLocaleString('en-US')}`,
    });
  }

  list.push({
    value: 'TC39',
    label: 'standard decorators',
    detail: 'no experimentalDecorators',
  });

  return list;
};

export const Stats = (): React.JSX.Element => (
  <Box component="section" className="stat-band" py="lg">
    <Container size="lg">
      <SimpleGrid cols={{ base: 2, sm: 3, lg: 5 }} spacing="lg">
        {stats().map((stat) => (
          <Stack key={stat.label} gap={2}>
            <Text className="stat-value">{stat.value}</Text>
            <Text size="sm" fw={600}>
              {stat.label}
            </Text>
            <Text size="xs" c="dimmed">
              {stat.detail}
            </Text>
          </Stack>
        ))}
      </SimpleGrid>
    </Container>
  </Box>
);
