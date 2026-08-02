import {
  ActionIcon,
  AppShell,
  Anchor,
  Box,
  Burger,
  Group,
  NavLink,
  ScrollArea,
  Text,
  UnstyledButton,
  VisuallyHidden,
  useMantineColorScheme,
} from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { spotlight } from '@mantine/spotlight';
import { Footer } from './components/Footer';
import { LogoMark, Wordmark } from './components/Logo';
import { Search } from './components/Search';
import { bench, site } from './data';
import { Benchmarks } from './pages/Benchmarks';
import { Coverage } from './pages/Coverage';
import { Guide } from './pages/Guide';
import { Home } from './pages/Home';
import { NotFound } from './pages/NotFound';
import { PackagePage } from './pages/PackagePage';
import { href, RouteKind, useRoute, useScrollTo, type Route } from './router';

const ColorSchemeToggle = (): React.JSX.Element => {
  const { colorScheme, setColorScheme } = useMantineColorScheme();
  const dark = colorScheme === 'dark';

  return (
    <ActionIcon
      variant="default"
      size="lg"
      aria-label="Toggle colour scheme"
      onClick={() => setColorScheme(dark ? 'light' : 'dark')}
    >
      {dark ? '☀' : '☾'}
    </ActionIcon>
  );
};

const Navigation = ({
  route,
  onNavigate,
}: {
  route: Route;
  onNavigate: () => void;
}): React.JSX.Element => (
  <>
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
    <NavLink
      component="a"
      href={href(RouteKind.Home)}
      label="Overview"
      active={route.kind === RouteKind.Home}
      onClick={onNavigate}
    />

    <Text size="xs" fw={700} tt="uppercase" c="dimmed" mt="md" mb={4} px="xs">
      Guides
    </Text>
    {site.guides.map((guide) => (
      <NavLink
        key={guide.slug}
        component="a"
        href={href(RouteKind.Guide, guide.slug)}
        label={guide.title}
        active={route.kind === RouteKind.Guide && route.slug === guide.slug}
        onClick={onNavigate}
      />
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
        description={`${pkg.symbols.filter((s) => s.subpaths.length > 0).length} exports`}
        active={route.kind === RouteKind.Api && route.slug === pkg.dir}
        onClick={onNavigate}
      />
    ))}

    <Text size="xs" fw={700} tt="uppercase" c="dimmed" mt="md" mb={4} px="xs">
      Quality
    </Text>
    <NavLink
      component="a"
      href={href(RouteKind.Coverage)}
      label="Coverage"
      active={route.kind === RouteKind.Coverage}
      onClick={onNavigate}
    />
  </>
);

/** Plain anchors, not a `nav` — the sidebar is the page's one navigation
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
        MIT licensed. Nothing here reimplements what Bun already ships.
      </Text>
      <Group gap="lg">
        <Anchor href={href(RouteKind.Bench)} size="sm" c="dimmed">
          Benchmarks
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
 * a documentation page, which is the thing being fixed — and it means the
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
        <Page route={route} />
        <DocsFooter />
        <Search />
      </AppShell.Main>
    </AppShell>
  );
};
