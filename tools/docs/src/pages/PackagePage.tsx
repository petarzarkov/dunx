import {
  Badge,
  Box,
  Container,
  Group,
  SegmentedControl,
  Stack,
  Switch,
  Tabs,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { useEffect, useMemo, useState } from 'react';
import type { DocSymbol } from '../../scripts/extract/model';
import { Prose } from '../components/Prose';
import { SymbolCard } from '../components/SymbolCard';
import { packageByDir, site } from '../data';
import { anchoredSymbol } from '../router';
import { NotFound } from './NotFound';

const KINDS = ['all', 'class', 'function', 'interface', 'type', 'variable'];

const matches = (symbol: DocSymbol, query: string): boolean => {
  if (query === '') return true;
  const needle = query.toLowerCase();
  return (
    symbol.name.toLowerCase().includes(needle) ||
    symbol.signature.toLowerCase().includes(needle)
  );
};

const ApiReference = ({
  dir,
  linked,
}: {
  dir: string;
  linked: string | null;
}): React.JSX.Element => {
  const pkg = packageByDir(dir);
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState('all');
  const [showInternal, setShowInternal] = useState(false);

  /**
   * A linked symbol passes every filter. The reader asked for that one by name,
   * so a stale kind filter, a leftover query, or its being internal must not be
   * what decides whether the page they were sent to contains it.
   */
  const symbols = useMemo(() => {
    const all = pkg?.symbols ?? [];
    return all.filter(
      (symbol) =>
        symbol.name === linked ||
        ((showInternal || symbol.subpaths.length > 0) &&
          (kind === 'all' || symbol.kind === kind) &&
          matches(symbol, query)),
    );
  }, [pkg, query, kind, showInternal, linked]);

  if (!pkg) return <NotFound what={`package "${dir}"`} />;

  const internalCount = pkg.symbols.filter(
    (s) => s.subpaths.length === 0,
  ).length;

  return (
    <Stack gap="md">
      <Box className="filters">
        <Stack gap="xs">
          <Group gap="sm" wrap="wrap">
            <TextInput
              placeholder="Filter symbols…"
              value={query}
              onChange={(event) => setQuery(event.currentTarget.value)}
              style={{ flex: '1 1 16rem' }}
            />
            <Switch
              label={`Internal (${internalCount})`}
              checked={showInternal}
              onChange={(event) => setShowInternal(event.currentTarget.checked)}
            />
          </Group>
          <SegmentedControl
            size="xs"
            value={kind}
            onChange={setKind}
            data={KINDS}
            fullWidth
          />
        </Stack>
      </Box>

      <Text size="sm" c="dimmed">
        {symbols.length} of {pkg.symbols.length} symbols
      </Text>

      {symbols.map((symbol) => (
        <SymbolCard
          key={`${symbol.file}#${symbol.name}`}
          symbol={symbol}
          repoUrl={site.repoUrl}
          linked={symbol.name === linked}
        />
      ))}

      {symbols.length === 0 && (
        <Text c="dimmed">Nothing matches that filter.</Text>
      )}
    </Stack>
  );
};

export const PackagePage = ({
  dir,
  anchor,
}: {
  dir: string;
  anchor: string | null;
}): React.JSX.Element => {
  const pkg = packageByDir(dir);
  const linked = anchoredSymbol(anchor);
  /**
   * A `?h=symbol-…` route has to open the API tab, or the card it names is
   * never mounted and the reader lands on the readme instead. Set on mount for
   * a cold load, and again on the effect for a hash change that keeps this page
   * instance alive.
   */
  const [tab, setTab] = useState<string | null>(linked ? 'api' : 'readme');

  useEffect(() => {
    if (linked) setTab('api');
  }, [linked]);

  if (!pkg) return <NotFound what={`package "${dir}"`} />;

  return (
    <Container size="lg" py="xl">
      <Stack gap="lg">
        <Stack gap={6}>
          <Title order={1} ff="monospace" size="h2">
            {pkg.name}
          </Title>
          <Text c="dimmed">{pkg.description}</Text>
          <Group gap={6}>
            {pkg.subpaths.map((subpath) => (
              <Badge key={subpath} variant="light" size="sm">
                {pkg.name}
                {subpath === '.' ? '' : subpath.slice(1)}
              </Badge>
            ))}
          </Group>
        </Stack>

        <Tabs value={tab} onChange={setTab} keepMounted={false}>
          <Tabs.List>
            <Tabs.Tab value="readme">Readme</Tabs.Tab>
            <Tabs.Tab value="api">
              API reference
              <Badge ml={6} size="xs" variant="default">
                {pkg.symbols.filter((s) => s.subpaths.length > 0).length}
              </Badge>
            </Tabs.Tab>
          </Tabs.List>

          <Tabs.Panel value="readme" pt="md">
            {pkg.readme ? (
              <Prose html={pkg.readme} />
            ) : (
              <Text c="dimmed">This package has no README.</Text>
            )}
          </Tabs.Panel>

          <Tabs.Panel value="api" pt="md">
            <ApiReference dir={dir} linked={linked} />
          </Tabs.Panel>
        </Tabs>
      </Stack>
    </Container>
  );
};
