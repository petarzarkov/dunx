import {
  Accordion,
  Anchor,
  Badge,
  Container,
  Group,
  Progress,
  SimpleGrid,
  Stack,
  Table,
  Text,
  Title,
} from '@mantine/core';
import { Stat } from '../components/Stat';
import type { CoveragePackage } from '../../scripts/extract/model';
import { coverage, hasCoverage, site } from '../data';

const pct = (hit: number, found: number): number =>
  found === 0 ? 100 : (hit / found) * 100;

const format = (value: number): string =>
  value === 100 ? '100' : value.toFixed(1);

const color = (value: number): string =>
  value >= 90 ? 'green' : value >= 75 ? 'yellow' : 'red';

const PackagePanel = ({ pkg }: { pkg: CoveragePackage }): React.JSX.Element => {
  const lines = pct(pkg.linesHit, pkg.lines);

  return (
    <Accordion.Item value={pkg.name}>
      <Accordion.Control>
        <Group justify="space-between" wrap="nowrap" pr="md">
          <Text ff="monospace" fw={600} size="sm">
            @dunx/{pkg.name}
          </Text>
          <Group gap="sm" wrap="nowrap" style={{ flex: '0 1 20rem' }}>
            <Progress
              value={lines}
              color={color(lines)}
              size="sm"
              style={{ flex: 1, minWidth: '5rem' }}
            />
            <Text size="sm" fw={600} c={color(lines)} w={56} ta="right">
              {format(lines)}%
            </Text>
          </Group>
        </Group>
      </Accordion.Control>
      <Accordion.Panel>
        <Table.ScrollContainer minWidth={640}>
          <Table verticalSpacing={4} fz="xs" striped>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>File</Table.Th>
                <Table.Th ta="right">Lines</Table.Th>
                <Table.Th ta="right">Covered</Table.Th>
                <Table.Th ta="right">Functions</Table.Th>
                <Table.Th>Uncovered</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {pkg.files.map((file) => {
                const value = pct(file.linesHit, file.lines);
                return (
                  <Table.Tr key={file.path}>
                    <Table.Td ff="monospace">
                      <Anchor
                        href={`${site.repoUrl}/blob/main/${file.path}`}
                        target="_blank"
                        c="inherit"
                      >
                        {file.path.replace(/^packages\/[^/]+\//, '')}
                      </Anchor>
                    </Table.Td>
                    <Table.Td ta="right" c={color(value)} fw={600}>
                      {format(value)}%
                    </Table.Td>
                    <Table.Td ta="right">
                      {file.linesHit}/{file.lines}
                    </Table.Td>
                    <Table.Td ta="right">
                      {file.funcsHit}/{file.funcs}
                    </Table.Td>
                    <Table.Td c="dimmed" ff="monospace">
                      {file.uncovered || '-'}
                    </Table.Td>
                  </Table.Tr>
                );
              })}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      </Accordion.Panel>
    </Accordion.Item>
  );
};

export const Coverage = (): React.JSX.Element => {
  const { totals, packages, untested } = coverage;
  const lines = pct(totals.linesHit, totals.lines);
  const funcs = pct(totals.funcsHit, totals.funcs);

  return (
    <Container size="lg" py="xl">
      <Stack gap="lg">
        <Stack gap={4}>
          <Title order={1}>Coverage</Title>
          <Text c="dimmed" size="sm">
            Weighted over every package, from the single root{' '}
            <code>bun test --coverage</code> run. Lines and functions only - Bun
            emits no branch records.
          </Text>
        </Stack>

        {!hasCoverage ? (
          <Text c="dimmed">
            No coverage data in this build. Run <code>bun run test:cov</code>,
            then rebuild the site.
          </Text>
        ) : (
          <>
            <SimpleGrid cols={{ base: 1, sm: 3 }}>
              <Stat
                label="Lines"
                value={`${format(lines)}%`}
                hint={`${totals.linesHit} / ${totals.lines}`}
              />
              <Stat
                label="Functions"
                value={`${format(funcs)}%`}
                hint={`${totals.funcsHit} / ${totals.funcs}`}
              />
              <Stat
                label="Packages"
                value={String(packages.length)}
                hint={
                  coverage.commit
                    ? `commit ${coverage.commit.slice(0, 7)}`
                    : new Date(coverage.generatedAt).toUTCString()
                }
              />
            </SimpleGrid>

            <Accordion
              variant="separated"
              multiple
              defaultValue={packages
                .filter((pkg) => pct(pkg.linesHit, pkg.lines) < 90)
                .map((pkg) => pkg.name)}
            >
              {packages.map((pkg) => (
                <PackagePanel key={pkg.name} pkg={pkg} />
              ))}
            </Accordion>

            {untested.length > 0 && (
              <Group gap={6}>
                <Text size="sm" c="dimmed">
                  No test files in:
                </Text>
                {untested.map((name) => (
                  <Badge key={name} variant="default" size="sm">
                    @dunx/{name}
                  </Badge>
                ))}
              </Group>
            )}
          </>
        )}
      </Stack>
    </Container>
  );
};
