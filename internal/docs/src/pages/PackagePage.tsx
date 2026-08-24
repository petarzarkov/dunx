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
import { Prose } from '@dunx/ui';
import { useMemo, useState } from 'react';
import type { DocSymbol, PackageBody } from '../../scripts/extract/model';
import { useChunk } from '../chunk';

import { SymbolCard } from '../components/SymbolCard';
import { loadPackage, packageByDir, site } from '../data';
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
  body,
  linked,
}: {
  body: PackageBody | undefined;
  linked: string | null;
}): React.JSX.Element => {
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState('all');
  const [showInternal, setShowInternal] = useState(false);

  /**
   * A linked symbol passes every filter. The reader asked for that one by name,
   * so a stale kind filter, a leftover query, or its being internal must not be
   * what decides whether the page they were sent to contains it.
   */
  const symbols = useMemo(() => {
    const all = body?.symbols ?? [];
    return all.filter(
      (symbol) =>
        symbol.name === linked ||
        ((showInternal || symbol.subpaths.length > 0) &&
          (kind === 'all' || symbol.kind === kind) &&
          matches(symbol, query)),
    );
  }, [body, query, kind, showInternal, linked]);

  if (!body) return <Text c="dimmed">Loading the API reference…</Text>;

  const internalCount = body.symbols.filter(
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
        {symbols.length} of {body.symbols.length} symbols
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
  const body = useChunk(() => loadPackage(dir), dir);
  const linked = anchoredSymbol(anchor);
  /**
   * A `?h=symbol-…` route has to open the API tab, or the card it names is
   * never mounted and the reader lands on the readme instead. Set on mount for
   * a cold load, and adjusted during render for a hash change that keeps this
   * page instance alive - from an effect, the readme tab paints first.
   */
  const [tab, setTab] = useState<string | null>(linked ? 'api' : 'readme');
  const [lastLinked, setLastLinked] = useState(linked);

  if (linked !== lastLinked) {
    setLastLinked(linked);
    if (linked) setTab('api');
  }

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
                {pkg.exports.length}
              </Badge>
            </Tabs.Tab>
          </Tabs.List>

          <Tabs.Panel value="readme" pt="md">
            {body === undefined ? (
              <Text c="dimmed">Loading the readme…</Text>
            ) : body.readme ? (
              <Prose html={body.readme} />
            ) : (
              <Text c="dimmed">This package has no README.</Text>
            )}
          </Tabs.Panel>

          <Tabs.Panel value="api" pt="md">
            <ApiReference body={body} linked={linked} />
          </Tabs.Panel>
        </Tabs>
      </Stack>
    </Container>
  );
};
