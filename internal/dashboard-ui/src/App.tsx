import {
  Alert,
  AppShell,
  Anchor,
  Badge,
  Burger,
  Group,
  Loader,
  MantineProvider,
  NavLink,
  Switch,
  Text,
  VisuallyHidden,
} from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import {
  ColorSchemeToggle,
  DatabaseIcon,
  LogoMark,
  RefreshIcon,
  RouteIcon,
  StackIcon,
  StatusDot,
  Wordmark,
  theme,
} from '@dunx/ui';
import { useMemo, useState, type JSX } from 'react';
import { Api } from './api';
import { duration } from './format';
import type { Meta } from './meta';
import { Config } from './panels/Config';
import { Gateways } from './panels/Gateways';
import { Graph } from './panels/Graph';
import { Overview } from './panels/Overview';
import { Queues } from './panels/Queues';
import { Routes } from './panels/Routes';
import { usePoll, useOnce } from './poll';
import {
  hrefFor,
  isPlainClick,
  useRoute,
  type Panel as PanelName,
} from './router';

const NAV: readonly {
  panel: PanelName;
  label: string;
  icon: JSX.Element;
}[] = [
  { panel: 'overview', label: 'Overview', icon: <StackIcon /> },
  { panel: 'routes', label: 'Routes', icon: <RouteIcon /> },
  { panel: 'gateways', label: 'Gateways', icon: <RouteIcon /> },
  { panel: 'graph', label: 'Modules & providers', icon: <StackIcon /> },
  { panel: 'queues', label: 'Queues & Redis', icon: <DatabaseIcon /> },
  { panel: 'config', label: 'Configuration', icon: <DatabaseIcon /> },
];

/**
 * The shell is the documentation site's, deliberately: header with the mark, a
 * navbar of panels, one scroll container. Someone who has read the dunx docs and
 * then opens their own app's dashboard should not be able to tell the two were
 * built separately - which is the whole reason `@dunx/ui` exists.
 */
export const App = ({ meta }: { meta: Meta }): JSX.Element => {
  const api = useMemo(() => new Api(meta.basePath), [meta.basePath]);
  const { panel, navigate } = useRoute(meta.basePath);
  const [opened, { toggle, close }] = useDisclosure(false);
  const [live, setLive] = useState(meta.pollMs > 0);
  const interval = live ? meta.pollMs : 0;

  // Static, so it is fetched once and never polled: routes and the provider graph
  // cannot change while the process runs.
  const snapshot = useOnce(() => api.snapshot());
  const runtime = usePoll(() => api.runtime(), interval, []);
  const redis = usePoll(() => api.redis(), interval, []);
  // Names only, and they cannot change while the process runs - but the board may
  // become reachable, so it is polled rather than fetched once.
  const queues = usePoll(() => api.queues(), interval, []);

  const refresh = (): void => {
    runtime.refresh();
    redis.refresh();
    queues.refresh();
  };

  const failing = runtime.data?.probes.some((probe) => probe.state === 'down');

  const body = (): JSX.Element => {
    if (snapshot.error !== undefined) {
      return (
        <Alert color="red" title="Could not read this app">
          {snapshot.error}
        </Alert>
      );
    }
    if (snapshot.data === undefined) return <Loader />;

    switch (panel) {
      case 'routes':
        return (
          <Routes
            routes={snapshot.data.routes}
            gateways={snapshot.data.gateways}
            meta={meta}
          />
        );
      case 'gateways':
        return <Gateways gateways={snapshot.data.gateways} />;
      case 'graph':
        return (
          <Graph
            modules={snapshot.data.modules}
            providers={snapshot.data.providers}
          />
        );
      case 'queues':
        return <Queues report={queues.data} redis={redis.data} meta={meta} />;
      case 'config':
        return <Config config={snapshot.data.config} />;
      default:
        return (
          <Overview
            snapshot={snapshot.data}
            runtime={runtime.data}
            queues={queues.data}
            meta={meta}
          />
        );
    }
  };

  return (
    <MantineProvider theme={theme} defaultColorScheme="auto">
      <AppShell
        header={{ height: 56 }}
        navbar={{
          width: 240,
          breakpoint: 'sm',
          collapsed: { mobile: !opened },
        }}
        padding="md"
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
              <Anchor
                href={hrefFor('overview', meta.basePath)}
                underline="never"
                c="inherit"
                onClick={(event) => {
                  if (!isPlainClick(event)) return;
                  event.preventDefault();
                  navigate('overview');
                }}
              >
                <Group gap={10} wrap="nowrap" align="center">
                  <LogoMark size={26} />
                  <Wordmark height={19} />
                  <VisuallyHidden>dunx</VisuallyHidden>
                </Group>
              </Anchor>
              <Badge variant="light" color="gray">
                {meta.title}
              </Badge>
            </Group>
            <Group gap="sm" wrap="nowrap">
              {runtime.data && (
                <Text size="xs" c="dimmed" visibleFrom="sm">
                  up {duration(runtime.data.uptimeMs)}
                </Text>
              )}
              <StatusDot
                state={
                  runtime.error !== undefined
                    ? 'down'
                    : failing === true
                      ? 'down'
                      : runtime.data === undefined
                        ? 'unknown'
                        : 'up'
                }
                label={runtime.error !== undefined ? 'unreachable' : 'live'}
              />
              {meta.pollMs > 0 && (
                <Switch
                  size="xs"
                  checked={live}
                  onChange={(event) => setLive(event.currentTarget.checked)}
                  label={`${meta.pollMs / 1000}s`}
                  aria-label="Poll for updates"
                  visibleFrom="xs"
                />
              )}
              <Anchor
                component="button"
                type="button"
                onClick={refresh}
                c="dimmed"
                aria-label="Refresh now"
                title="Refresh now"
                display="flex"
              >
                <RefreshIcon />
              </Anchor>
              <ColorSchemeToggle />
            </Group>
          </Group>
        </AppShell.Header>

        <AppShell.Navbar p="xs">
          {NAV.map((entry) => (
            <NavLink
              key={entry.panel}
              component="a"
              // A real href, so middle-click and open-in-new-tab work and the page
              // still navigates if the bundle fails. Only a plain left-click is
              // taken over.
              href={hrefFor(entry.panel, meta.basePath)}
              label={entry.label}
              leftSection={entry.icon}
              active={panel === entry.panel}
              onClick={(event) => {
                if (!isPlainClick(event)) return;
                event.preventDefault();
                navigate(entry.panel);
                close();
              }}
            />
          ))}
          <NavLink
            component="a"
            href={meta.queuesPath}
            label="bull-board"
            description="Jobs, flows and metrics"
            leftSection={<DatabaseIcon />}
          />
          {meta.openApiPath !== undefined && (
            <NavLink
              component="a"
              href={meta.openApiPath}
              target="_blank"
              label="API explorer"
              description="What a client can call"
              rel="noreferrer"
            />
          )}
        </AppShell.Navbar>

        {/* No Container. The documentation site caps its width because a reading
            measure matters for prose; every panel here is a wide table or a row of
            counters, and a gutter on a 2560px monitor just makes the route table
            scroll horizontally for no reason. */}
        <AppShell.Main>{body()}</AppShell.Main>
      </AppShell>
    </MantineProvider>
  );
};
