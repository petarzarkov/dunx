import { Spotlight, type SpotlightActionData } from '@mantine/spotlight';
import { useMemo } from 'react';
import { site } from '../data';
import { href, navigate, RouteKind } from '../router';

/**
 * One flat action list over everything the build produced: guides, their
 * section headings, the packages, and every documented symbol.
 */
const buildActions = (): SpotlightActionData[] => {
  const actions: SpotlightActionData[] = site.guides.map((guide) => ({
    id: `guide-${guide.slug}`,
    label: guide.title,
    description: guide.source,
    group: 'Guides',
    onClick: () => navigate(href(RouteKind.Guide, guide.slug)),
  }));

  for (const guide of site.guides) {
    for (const heading of guide.headings) {
      actions.push({
        id: `heading-${guide.slug}-${heading.id}`,
        label: heading.text,
        description: guide.title,
        group: 'Sections',
        onClick: () =>
          navigate(`${href(RouteKind.Guide, guide.slug)}?h=${heading.id}`),
      });
    }
  }

  for (const pkg of site.packages) {
    actions.push({
      id: `package-${pkg.dir}`,
      label: pkg.name,
      description: pkg.description,
      group: 'Packages',
      onClick: () => navigate(href(RouteKind.Api, pkg.dir)),
    });

    for (const symbol of pkg.symbols) {
      if (symbol.subpaths.length === 0) continue;
      actions.push({
        id: `symbol-${pkg.dir}-${symbol.name}-${symbol.line}`,
        label: symbol.name,
        description: `${symbol.kind} · ${pkg.name}`,
        group: 'API',
        onClick: () => navigate(href(RouteKind.Api, pkg.dir)),
      });
    }
  }

  return actions;
};

export const Search = (): React.JSX.Element => {
  const actions = useMemo(buildActions, []);

  return (
    <Spotlight
      actions={actions}
      nothingFound="Nothing found"
      limit={12}
      highlightQuery
      shortcut={['mod + K', '/']}
      searchProps={{ placeholder: 'Search the docs and the API…' }}
    />
  );
};
