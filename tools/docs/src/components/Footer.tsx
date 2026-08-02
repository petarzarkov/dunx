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
 * The landing page has no sidebar, so this is the only navigation on it — which
 * is why every package is listed here rather than a curated few.
 */
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

            <Column title="Guides">
              {site.guides.map((guide) => (
                <Link
                  key={guide.slug}
                  to={href(RouteKind.Guide, guide.slug)}
                  label={guide.title}
                />
              ))}
            </Column>
          </Group>
        </Group>

        <Text size="xs" c="dimmed">
          Generated from the source on{' '}
          {new Date(site.generatedAt).toUTCString()}.
        </Text>
      </Stack>
    </Container>
  </Box>
);
