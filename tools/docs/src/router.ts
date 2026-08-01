import { useEffect, useState } from 'react';

export const RouteKind = Object.freeze({
  Home: 'home',
  Guide: 'guide',
  Api: 'api',
  Coverage: 'coverage',
  NotFound: 'not-found',
} as const);
export type RouteKind = (typeof RouteKind)[keyof typeof RouteKind];

export interface Route {
  readonly kind: RouteKind;
  readonly slug: string;
  /** Heading id to scroll to once the page has rendered. */
  readonly anchor: string | null;
}

const KINDS: Record<string, RouteKind> = {
  guide: RouteKind.Guide,
  api: RouteKind.Api,
  coverage: RouteKind.Coverage,
};

export const parseRoute = (hash: string): Route => {
  const [path = '', query = ''] = hash.replace(/^#\/?/, '').split('?');
  const anchor = new URLSearchParams(query).get('h');
  const [head = '', slug = ''] = path.split('/');

  if (head === '') return { kind: RouteKind.Home, slug: '', anchor };

  const kind = KINDS[head];
  if (!kind) return { kind: RouteKind.NotFound, slug: path, anchor };

  return { kind, slug: decodeURIComponent(slug), anchor };
};

export const href = (kind: RouteKind, slug = ''): string =>
  kind === RouteKind.Home ? '#/' : `#/${kind}${slug ? `/${slug}` : ''}`;

export const useRoute = (): Route => {
  const [route, setRoute] = useState(() => parseRoute(window.location.hash));

  useEffect(() => {
    const update = (): void => setRoute(parseRoute(window.location.hash));
    window.addEventListener('hashchange', update);
    return () => window.removeEventListener('hashchange', update);
  }, []);

  return route;
};

export const navigate = (target: string): void => {
  window.location.hash = target;
};

/**
 * Restores position on navigation: to the requested heading when the link
 * carried one, to the top otherwise. Deferred a frame so the new page's DOM
 * exists before the lookup.
 */
export const useScrollTo = (route: Route): void => {
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      if (!route.anchor) {
        window.scrollTo({ top: 0 });
        return;
      }
      document
        .getElementById(route.anchor)
        ?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    });
    return () => cancelAnimationFrame(frame);
  }, [route.kind, route.slug, route.anchor]);
};
