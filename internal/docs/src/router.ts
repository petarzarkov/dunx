import { useEffect, useState } from 'react';

export const RouteKind = Object.freeze({
  Home: 'home',
  Bench: 'benchmarks',
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
  benchmarks: RouteKind.Bench,
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

const SYMBOL_PREFIX = 'symbol-';

/** The DOM id `SymbolCard` renders, and the anchor a search hit navigates to. */
export const symbolAnchor = (name: string): string => `${SYMBOL_PREFIX}${name}`;

/**
 * A package page scrolled to one symbol. Without the `?h=`, every API hit in
 * the search results lands on the top of the same page - which is the bug this
 * exists to prevent recurring.
 */
export const symbolHref = (dir: string, name: string): string =>
  `${href(RouteKind.Api, dir)}?h=${symbolAnchor(name)}`;

/** The symbol a route's anchor names, or `null` if it names a heading. */
export const anchoredSymbol = (anchor: string | null): string | null =>
  anchor?.startsWith(SYMBOL_PREFIX) === true
    ? anchor.slice(SYMBOL_PREFIX.length)
    : null;

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

/** Frames to keep looking for the target before giving up. */
const SCROLL_ATTEMPTS = 30;

/**
 * Restores position on navigation: to the requested heading or symbol when the
 * link carried one, to the top otherwise.
 *
 * It retries across frames rather than looking once. The target may not be in
 * the DOM yet on the frame the route changes - a package page opens the API tab
 * in response to the anchor, and `Tabs` is `keepMounted={false}`, so the card
 * mounts a commit later. Looking once is what made a search hit land on the top
 * of the page instead of on the symbol.
 */
export const useScrollTo = (route: Route): void => {
  const { anchor } = route;

  useEffect(() => {
    if (anchor === null) {
      window.scrollTo({ top: 0 });
      return;
    }

    let frame = 0;
    let attempts = 0;
    let landed = false;

    /**
     * Instant, not smooth: a cold load can be two thousand pixels short of the
     * target, and it keeps re-running until the element stops moving. Cards
     * below the fold finish laying out after the one scroll a single pass would
     * have done, which leaves the reader near the symbol rather than on it.
     */
    const look = (): void => {
      attempts += 1;
      const target = document.getElementById(anchor);

      if (target) {
        const before = target.getBoundingClientRect().top;
        target.scrollIntoView?.({ block: 'start', behavior: 'auto' });
        if (landed && Math.abs(before - target.getBoundingClientRect().top) < 1)
          return;
        landed = true;
      }

      if (attempts < SCROLL_ATTEMPTS) frame = requestAnimationFrame(look);
    };

    frame = requestAnimationFrame(look);
    return () => cancelAnimationFrame(frame);
  }, [route.kind, route.slug, anchor]);
};
