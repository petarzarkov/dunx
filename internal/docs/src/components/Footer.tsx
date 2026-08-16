import { Anchor, Box, Container, Group, Stack, Text } from '@mantine/core';
import { site } from '../data';
import { href, RouteKind } from '../router';

const Column = ({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}): React.JSX.Element => (
  <Stack gap={6}>
    <Text size="xs" fw={700} tt="uppercase" c="dimmed">
      {title}
    </Text>
    {children}
  </Stack>
);

const Link = ({
  to,
  label,
  mono = false,
}: {
  to: string;
  label: string;
  mono?: boolean;
}): React.JSX.Element => {
  // Only an absolute URL leaves the site; every route here is a hash.
  const external = to.startsWith('http');
  return (
    <Anchor
      href={to}
      size="sm"
      c="dimmed"
      {...(mono ? { ff: 'monospace' } : {})}
      {...(external ? { target: '_blank', rel: 'noreferrer' } : {})}
    >
      {label}
    </Anchor>
  );
};

/**
 * The landing page has no sidebar, so this is its only navigation. The packages
 * are listed in full because that list is the API reference; the guides are not,
 * because listing all 19 made the footer taller than the page above it.
 *
 * Resolved against the generated index rather than hard-coded, so a renamed page
 * drops out of the footer instead of linking at a route that no longer exists.
 */
const LEARN: readonly string[] = [
  'first-steps',
  'providers',
  'modules',
  'configuration',
  'testing',
  'migration-from-nest',
];

const learnLinks = (): { slug: string; title: string }[] =>
  LEARN.map((slug) => site.guides.find((guide) => guide.slug === slug)).filter(
    (guide): guide is (typeof site.guides)[number] => guide !== undefined,
  );

export const Footer = (): React.JSX.Element => (
  <Box component="footer" className="site-footer" py="xl" mt={0}>
    <Container size="lg">
      <Stack gap="xl">
        <Group align="flex-start" justify="space-between" wrap="wrap" gap="xl">
          <Stack gap={4} maw={300}>
            <Text fw={800} ff="monospace" size="lg">
              dunx
            </Text>
            <Text size="sm" c="dimmed">
              A Bun-native dependency injection framework. Nothing the platform
              ships is reimplemented, nothing a mature library solves is
              invented.
            </Text>
          </Stack>

          <Group
            component="nav"
            align="flex-start"
            gap={48}
            wrap="wrap"
            aria-label="Site"
          >
            <Column title="Project">
              <Link to={href(RouteKind.Bench)} label="Benchmarks" />
              <Link to={href(RouteKind.Coverage)} label="Coverage" />
              <Link to={site.repoUrl} label="GitHub" />
              <Link to="https://www.npmjs.com/org/dunx" label="npm" />
            </Column>

            <Column title="Packages">
              {site.packages.map((pkg) => (
                <Link
                  key={pkg.dir}
                  to={href(RouteKind.Api, pkg.dir)}
                  label={pkg.name}
                  mono
                />
              ))}
            </Column>

            <Column title="Learn">
              {learnLinks().map((guide) => (
                <Link
                  key={guide.slug}
                  to={href(RouteKind.Guide, guide.slug)}
                  label={guide.title}
                />
              ))}
              <Link
                to={href(RouteKind.Guide, 'introduction')}
                label="All guides"
              />
            </Column>
          </Group>
        </Group>

        <Group justify="space-between" align="center" gap="md">
          <Text size="xs" c="dimmed">
            Copyright &copy; 2026 MIT by{' '}
            <Anchor
              href="https://petarzarkov.com/"
              target="_blank"
              rel="noreferrer"
              size="xs"
              c="dimmed"
              underline="always"
            >
              Petar Zarkov
            </Anchor>{' '}
            &middot;{' '}
            <Anchor
              href="https://github.com/petarzarkov"
              target="_blank"
              rel="noreferrer"
              size="xs"
              c="dimmed"
              underline="always"
            >
              @petarzarkov
            </Anchor>
          </Text>
          <Text size="xs" c="dimmed">
            Generated from the source on{' '}
            {new Date(site.generatedAt).toUTCString()}.
          </Text>
        </Group>
      </Stack>
    </Container>
  </Box>
);
