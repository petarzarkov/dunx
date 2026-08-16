import {
  Anchor,
  Badge,
  Card,
  Container,
  Group,
  Skeleton,
  Stack,
  Text,
  Title,
} from '@mantine/core';
import { Prose } from '@dunx/ui';
import { useChunk } from '../chunk';
import { loadReleases, site } from '../data';

const DATE = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
});

const formatDate = (date: string): string => {
  const parsed = new Date(`${date}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) ? date : DATE.format(parsed);
};

export const Releases = (): React.JSX.Element => {
  const releases = useChunk(loadReleases, 'releases');

  return (
    <Container size="md" py="xl">
      <Stack gap="lg">
        <Stack gap={4}>
          <Title order={1}>Releases</Title>
          <Text c="dimmed" size="sm">
            Every @dunx package shares one version and ships together, so a
            release covers all {site.packages.length} of them. Written from the
            commits in each release range.
          </Text>
        </Stack>

        {releases === undefined ? (
          <Stack gap="lg">
            {[0, 1, 2].map((n) => (
              <Skeleton key={n} height={140} radius="md" />
            ))}
          </Stack>
        ) : releases.length === 0 ? (
          <Text c="dimmed">
            No releases recorded yet. <code>bun run version</code> writes them.
          </Text>
        ) : (
          releases.map((release) => (
            <Card key={release.version} withBorder radius="md" padding="lg">
              <Group justify="space-between" align="center" mb="sm">
                <Title order={2} id={release.anchor} fz="h3">
                  <Anchor
                    href={`#/releases?h=${release.anchor}`}
                    c="inherit"
                    underline="never"
                  >
                    {release.version}
                  </Anchor>
                </Title>
                <Group gap="xs">
                  <Text size="sm" c="dimmed">
                    {formatDate(release.date)}
                  </Text>
                  <Badge
                    variant="default"
                    size="sm"
                    component="a"
                    href={`https://www.npmjs.com/package/@dunx/core/v/${release.version}`}
                    target="_blank"
                    style={{ cursor: 'pointer' }}
                  >
                    npm
                  </Badge>
                </Group>
              </Group>
              <Prose html={release.html} />
            </Card>
          ))
        )}
      </Stack>
    </Container>
  );
};
