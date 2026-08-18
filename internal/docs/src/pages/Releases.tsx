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
import { href, npmUrl, RouteKind } from '../router';
import { NotFound } from './NotFound';

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
                    href={href(RouteKind.Releases, release.version)}
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
                    href={npmUrl('@dunx/core', release.version)}
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

/** A git tag is `v2.0.1`; `ReleaseNote.version` is `2.0.1`. Both must land. */
const stripTag = (slug: string): string => slug.replace(/^v/, '');

/**
 * One release, at `#/releases/<version>`, so a GitHub release note has a stable
 * URL to point at. It reads the same chunk the index does, so the duplicated body
 * costs no bytes.
 */
export const Release = ({ slug }: { slug: string }): React.JSX.Element => {
  const releases = useChunk(loadReleases, 'releases');
  const version = stripTag(slug);

  // Before `NotFound`: the history is a chunk, and judging a version missing
  // while it is still loading would show the panel on every first paint.
  if (releases === undefined) {
    return (
      <Container size="md" py="xl">
        <Skeleton height={320} radius="md" />
      </Container>
    );
  }

  const at = releases.findIndex((release) => release.version === version);
  const release = releases[at];
  if (!release) return <NotFound what={`release "${slug}"`} />;

  // Newest first, so the entry after this one is the older release.
  const newer = releases[at - 1];
  const older = releases[at + 1];

  return (
    <Container size="md" py="xl">
      <Stack gap="lg">
        <Anchor href={href(RouteKind.Releases)} size="sm" c="dimmed">
          All releases
        </Anchor>

        <Group justify="space-between" align="center">
          <Title order={1}>{release.version}</Title>
          <Text size="sm" c="dimmed">
            {formatDate(release.date)}
          </Text>
        </Group>

        <Group gap="xs">
          {site.packages.map((pkg) => (
            <Badge
              key={pkg.dir}
              variant="default"
              size="sm"
              component="a"
              href={npmUrl(pkg.name, release.version)}
              target="_blank"
              style={{ cursor: 'pointer' }}
            >
              {pkg.name}
            </Badge>
          ))}
        </Group>

        <Card withBorder radius="md" padding="lg">
          <Prose html={release.html} />
        </Card>

        <Group justify="space-between">
          {older ? (
            <Anchor href={href(RouteKind.Releases, older.version)} size="sm">
              Previous: {older.version}
            </Anchor>
          ) : (
            <span />
          )}
          {newer ? (
            <Anchor href={href(RouteKind.Releases, newer.version)} size="sm">
              Next: {newer.version}
            </Anchor>
          ) : (
            <span />
          )}
        </Group>
      </Stack>
    </Container>
  );
};
