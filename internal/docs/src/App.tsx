import {
  AppShell,
  Anchor,
  Box,
  Burger,
  Divider,
  Group,
  NavLink,
  ScrollArea,
  Text,
  UnstyledButton,
  VisuallyHidden,
} from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { Fragment } from 'react';
import { spotlight } from '@mantine/spotlight';
import { ColorSchemeToggle, LogoMark, Wordmark } from '@dunx/ui';
import { Footer } from './components/Footer';
import { Search } from './components/Search';
import { bench, site } from './data';
import { Benchmarks } from './pages/Benchmarks';
import { Coverage } from './pages/Coverage';
import { Guide } from './pages/Guide';
import { Home } from './pages/Home';
import { NotFound } from './pages/NotFound';
import { PackagePage } from './pages/PackagePage';
import { Release, Releases } from './pages/Releases';
import { href, RouteKind, useRoute, useScrollTo, type Route } from './router';

/**
 * The tour, grouped in the order the generator assigned. Built by walking the pages
 * rather than from a list of section names, so a section only appears when it has a
 * page in it and nothing has to be kept in sync with the generator.
 */
const guideSections = (): [string, (typeof site.guides)[number][]][] => {
  const groups: [string, (typeof site.guides)[number][]][] = [];
  for (const guide of site.guides) {
    if (guide.category !== 'guide') continue;
    const last = groups.at(-1);
    if (last?.[0] === guide.section) last[1].push(guide);
    else groups.push([guide.section, [guide]]);
  }
  return groups;
};

/**
 * The reference documents, sectionless ones first and then each named section in
 * the order the generator assigned. `order` is 0 for a page with no section, so
 * sorting on it keeps those at the top in their existing arrangement.
 */
const referenceSections = (): [string, (typeof site.guides)[number][]][] => {
  const groups = new Map<string, (typeof site.guides)[number][]>();
  for (const guide of site.guides) {
    if (guide.category !== 'reference') continue;
    const group = groups.get(guide.section) ?? [];
    group.push(guide);
    groups.set(guide.section, group);
  }
  for (const pages of groups.values()) {
    pages.sort((a, b) => a.order - b.order);
  }
  return [...groups].sort(([a], [b]) => a.localeCompare(b));
};

const Navigation = ({
  route,
  onNavigate,
}: {
  route: Route;
  onNavigate: () => void;
}): React.JSX.Element => (
  <>
    {/* The site's own two pages, ahead of the guide and separated from it. They
        used to sit unlabelled above the first section heading, which read as two
        entries someone had forgotten to file. */}
    <NavLink
      component="a"
      href={href(RouteKind.Home)}
      label="Overview"
      active={route.kind === RouteKind.Home}
      onClick={onNavigate}
    />
    <NavLink
      component="a"
      href={href(RouteKind.Bench)}
      label="Benchmarks"
      description={
        bench ? `${bench.subjects.length} subjects, vs Bun.serve` : 'No run yet'
      }
      active={route.kind === RouteKind.Bench}
      onClick={onNavigate}
    />
    <Divider my="sm" />

    {guideSections().map(([section, pages]) => (
      <Fragment key={section}>
        <Text
          size="xs"
          fw={700}
          tt="uppercase"
          c="dimmed"
          mt="md"
          mb={4}
          px="xs"
        >
          {section}
        </Text>
        {pages.map((guide) => (
          <NavLink
            key={guide.slug}
            component="a"
            href={href(RouteKind.Guide, guide.slug)}
            label={guide.title}
            active={route.kind === RouteKind.Guide && route.slug === guide.slug}
            onClick={onNavigate}
          />
        ))}
      </Fragment>
    ))}

    {/* The repo's own documents. Written for someone changing dunx rather than
        someone using it, which is why they are a separate group.

        Grouped the same way the tour is, because the architecture record is
        twelve pages with a reading order and four of them share a title with a
        guide - Logging, Database, Queues, Authentication. Flat and unsorted, that
        read as duplicates of the guides. */}
    {referenceSections().map(([section, pages]) => (
      <Fragment key={section || 'reference'}>
        <Text
          size="xs"
          fw={700}
          tt="uppercase"
          c="dimmed"
          mt="md"
          mb={4}
          px="xs"
        >
          {section || 'Reference'}
        </Text>
        {pages.map((guide) => (
          <NavLink
            key={guide.slug}
            component="a"
            href={href(RouteKind.Guide, guide.slug)}
            label={guide.title}
            active={route.kind === RouteKind.Guide && route.slug === guide.slug}
            onClick={onNavigate}
          />
        ))}
      </Fragment>
    ))}

    <Text size="xs" fw={700} tt="uppercase" c="dimmed" mt="md" mb={4} px="xs">
      Packages
    </Text>
    {site.packages.map((pkg) => (
      <NavLink
        key={pkg.dir}
        component="a"
        href={href(RouteKind.Api, pkg.dir)}
        label={pkg.name}
        description={`${pkg.exports.length} exports`}
        active={route.kind === RouteKind.Api && route.slug === pkg.dir}
        onClick={onNavigate}
      />
    ))}

    <Text size="xs" fw={700} tt="uppercase" c="dimmed" mt="md" mb={4} px="xs">
      Project
    </Text>
    <NavLink
      component="a"
      href={href(RouteKind.Releases)}
      label="Releases"
      active={route.kind === RouteKind.Releases}
      onClick={onNavigate}
    />
    <NavLink
      component="a"
      href={href(RouteKind.Coverage)}
      label="Coverage"
      active={route.kind === RouteKind.Coverage}
      onClick={onNavigate}
    />
  </>
);

/** Plain anchors, not a `nav` - the sidebar is the page's one navigation
 * landmark and a second would make it ambiguous to a screen reader. */
const DocsFooter = (): React.JSX.Element => (
  <Box component="footer" className="site-footer">
    <Group justify="space-between" align="center" gap="lg">
      <Group gap={10} wrap="nowrap" align="center">
        <LogoMark size={22} />
        <Wordmark height={16} />
        <VisuallyHidden>dunx</VisuallyHidden>
      </Group>
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
        </Anchor>
      </Text>
      <Group gap="lg">
        <Anchor href={href(RouteKind.Bench)} size="sm" c="dimmed">
          Benchmarks
        </Anchor>
        <Anchor href={href(RouteKind.Releases)} size="sm" c="dimmed">
          Releases
        </Anchor>
        <Anchor href={href(RouteKind.Coverage)} size="sm" c="dimmed">
          Coverage
        </Anchor>
        <Anchor href={site.repoUrl} target="_blank" size="sm" c="dimmed">
          GitHub
        </Anchor>
      </Group>
    </Group>
  </Box>
);

const Page = ({ route }: { route: Route }): React.JSX.Element => {
  switch (route.kind) {
    case RouteKind.Home:
      return <Home />;
    case RouteKind.Bench:
      return <Benchmarks />;
    case RouteKind.Guide:
      return <Guide slug={route.slug} />;
    case RouteKind.Api:
      return <PackagePage dir={route.slug} anchor={route.anchor} />;
    case RouteKind.Coverage:
      return <Coverage />;
    case RouteKind.Releases:
      // The slug is a version, and the parser already produced it. Without a
      // slug this is the whole history.
      return route.slug ? <Release slug={route.slug} /> : <Releases />;
    default:
      return <NotFound what={`page "${route.slug}"`} />;
  }
};

const Header = ({
  opened,
  onToggle,
  withBurger,
}: {
  opened: boolean;
  onToggle: () => void;
  withBurger: boolean;
}): React.JSX.Element => (
  <Group h="100%" px="md" justify="space-between" wrap="nowrap">
    <Group gap="sm" wrap="nowrap">
      {withBurger && (
        <Burger opened={opened} onClick={onToggle} hiddenFrom="sm" size="sm" />
      )}
      <Anchor href={href(RouteKind.Home)} underline="never" c="inherit">
        <Group gap={10} wrap="nowrap" align="center">
          <LogoMark size={26} />
          <Wordmark height={19} />
          <VisuallyHidden>dunx</VisuallyHidden>
        </Group>
      </Anchor>
    </Group>
    <Group gap="xs" wrap="nowrap">
      <Anchor
        href={href(RouteKind.Bench)}
        size="sm"
        c="dimmed"
        visibleFrom="xs"
      >
        Benchmarks
      </Anchor>
      <UnstyledButton className="search-trigger" onClick={spotlight.open}>
        <Text size="sm" c="dimmed">
          Search
        </Text>
        <Text size="xs" c="dimmed" className="kbd">
          ⌘K
        </Text>
      </UnstyledButton>
      <Anchor
        href={site.repoUrl}
        target="_blank"
        size="sm"
        c="dimmed"
        visibleFrom="sm"
      >
        GitHub
      </Anchor>
      <ColorSchemeToggle />
    </Group>
  </Group>
);

/**
 * The landing page drops the sidebar and runs full width; every other route
 * keeps it. A marketing page constrained to the documentation gutter looks like
 * a documentation page, which is the thing being fixed - and it means the
 * footer is the only navigation landmark on `#/`.
 */
export const App = (): React.JSX.Element => {
  const route = useRoute();
  const [opened, { toggle, close }] = useDisclosure(false);
  useScrollTo(route);
  const landing = route.kind === RouteKind.Home;

  if (landing) {
    return (
      <AppShell header={{ height: 56 }} padding={0}>
        <AppShell.Header>
          <Header opened={opened} onToggle={toggle} withBurger={false} />
        </AppShell.Header>
        <AppShell.Main>
          <Home />
          <Footer />
          <Search />
        </AppShell.Main>
      </AppShell>
    );
  }

  return (
    <AppShell
      header={{ height: 56 }}
      navbar={{ width: 280, breakpoint: 'sm', collapsed: { mobile: !opened } }}
      padding={0}
    >
      <AppShell.Header>
        <Header opened={opened} onToggle={toggle} withBurger />
      </AppShell.Header>

      <AppShell.Navbar p="xs">
        <ScrollArea type="scroll">
          <Navigation route={route} onNavigate={close} />
        </ScrollArea>
      </AppShell.Navbar>

      <AppShell.Main>
        {/* Keyed on the page, not the whole route, so the entrance replays on
            navigation while a `?h=symbol-...` on the page already open does not
            remount it - `PackagePage` opens its API tab from that anchor and has
            to survive the hash change. */}
        <div className="page-enter" key={`${route.kind}:${route.slug ?? ''}`}>
          <Page route={route} />
        </div>
        <DocsFooter />
        <Search />
      </AppShell.Main>
    </AppShell>
  );
};
