import {
  ActionIcon,
  AppShell,
  Anchor,
  Burger,
  Group,
  NavLink,
  ScrollArea,
  Text,
  UnstyledButton,
  useMantineColorScheme,
} from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { spotlight } from '@mantine/spotlight';
import { Search } from './components/Search';
import { site } from './data';
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

const Page = ({ route }: { route: Route }): React.JSX.Element => {
  switch (route.kind) {
    case RouteKind.Home:
      return <Home />;
    case RouteKind.Guide:
      return <Guide slug={route.slug} />;
    case RouteKind.Api:
      return <PackagePage dir={route.slug} />;
    case RouteKind.Coverage:
      return <Coverage />;
    default:
      return <NotFound what={`page "${route.slug}"`} />;
  }
};

export const App = (): React.JSX.Element => {
  const route = useRoute();
  const [opened, { toggle, close }] = useDisclosure(false);
  useScrollTo(route);

  return (
    <AppShell
      header={{ height: 56 }}
      navbar={{ width: 280, breakpoint: 'sm', collapsed: { mobile: !opened } }}
      padding={0}
    >
      <AppShell.Header>
        <Group h="100%" px="md" justify="space-between" wrap="nowrap">
          <Group gap="sm" wrap="nowrap">
            <Burger
              opened={opened}
              onClick={toggle}
              hiddenFrom="sm"
              size="sm"
            />
            <Anchor href={href(RouteKind.Home)} underline="never" c="inherit">
              <Text fw={800} size="lg" ff="monospace">
                dunx
              </Text>
            </Anchor>
          </Group>
          <Group gap="xs" wrap="nowrap">
            <UnstyledButton className="search-trigger" onClick={spotlight.open}>
              <Text size="sm" c="dimmed">
                Search
              </Text>
              <Text size="xs" c="dimmed" className="kbd">
                ⌘K
              </Text>
            </UnstyledButton>
            <Anchor href={site.repoUrl} target="_blank" size="sm" c="dimmed">
              GitHub
            </Anchor>
            <ColorSchemeToggle />
          </Group>
        </Group>
      </AppShell.Header>

      <AppShell.Navbar p="xs">
        <ScrollArea type="scroll">
          <Navigation route={route} onNavigate={close} />
        </ScrollArea>
      </AppShell.Navbar>

      <AppShell.Main>
        <Page route={route} />
        <Search />
      </AppShell.Main>
    </AppShell>
  );
};
