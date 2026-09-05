import { useEffect, useState } from 'react';

export const RouteKind = Object.freeze({
  Home: 'home',
  Bench: 'benchmarks',
  Guide: 'guide',
  Api: 'api',
  Coverage: 'coverage',
  Releases: 'releases',
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
  releases: RouteKind.Releases,
};

/** The pathname and search a link carries: `/guide/controllers?h=nesting`. */
export const parseRoute = (url: string): Route => {
  const [pathname = '', query = ''] = url.split('?');
  const anchor = new URLSearchParams(query).get('h');
  const path = pathname.replace(/^\/+/, '').replace(/\/+$/, '');
  const [head = '', ...rest] = path.split('/');

  if (head === '') return { kind: RouteKind.Home, slug: '', anchor };

  const kind = KINDS[head];
  if (!kind) return { kind: RouteKind.NotFound, slug: path, anchor };

  return { kind, slug: decodeURIComponent(rest.join('/')), anchor };
};

export const href = (kind: RouteKind, slug = ''): string =>
  kind === RouteKind.Home ? '/' : `/${kind}${slug ? `/${slug}` : ''}`;

/**
 * A package on npm, optionally pinned to one version.
 *
 * Here rather than in a page because three copies would otherwise exist: the
 * unversioned form was local to `pages/Home.tsx` and the versioned one was
 * hardcoded to `@dunx/core` inside `pages/Releases.tsx`.
 */
export const npmUrl = (name: string, version?: string): string =>
  `https://www.npmjs.com/package/${encodeURIComponent(name)}${
    version ? `/v/${version}` : ''
  }`;

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

/** `pushState` fires no event of its own, so navigation announces itself. */
const NAVIGATED = 'dunx:navigated';

const currentUrl = (): string =>
  `${window.location.pathname}${window.location.search}`;

export const navigate = (target: string): void => {
  if (target === currentUrl()) return;
  window.history.pushState(null, '', target);
  window.dispatchEvent(new Event(NAVIGATED));
};

/**
 * The pathname a click should navigate to without a page load, or `null` to
 * leave the click to the browser.
 *
 * One delegated listener rather than a `<Link>` component: every link on the
 * site is a Mantine `Anchor` or `NavLink` rendering a plain `<a href>`, and
 * wrapping each one would add a prop at every call site for behaviour the
 * document supplies once.
 *
 * Everything but an unmodified left click on a same-origin anchor is left
 * alone, which is what keeps middle-click, cmd-click and "open in new tab"
 * opening a real tab.
 */
const interceptable = (event: MouseEvent): string | null => {
  if (event.defaultPrevented || event.button !== 0) return null;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
    return null;
  }

  const anchor =
    event.target instanceof Element ? event.target.closest('a') : null;
  const raw = anchor?.getAttribute('href');
  if (!anchor || raw === null || raw === undefined) return null;
  if (anchor.hasAttribute('download')) return null;
  if (anchor.target !== '' && anchor.target !== '_self') return null;
  // A bare `#id` is a fragment the browser scrolls to on its own. The site uses
  // `?h=` instead, so anything reaching here is a link nothing else handles.
  if (raw.startsWith('#')) return null;

  const url = new URL(anchor.href, window.location.href);
  if (url.origin !== window.location.origin) return null;

  return `${url.pathname}${url.search}`;
};

export const useRoute = (): Route => {
  const [route, setRoute] = useState(() => parseRoute(currentUrl()));

  useEffect(() => {
    const update = (): void => setRoute(parseRoute(currentUrl()));
    window.addEventListener('popstate', update);
    window.addEventListener(NAVIGATED, update);
    return () => {
      window.removeEventListener('popstate', update);
      window.removeEventListener(NAVIGATED, update);
    };
  }, []);

  useEffect(() => {
    const onClick = (event: MouseEvent): void => {
      const target = interceptable(event);
      if (target === null) return;
      event.preventDefault();
      navigate(target);
    };
    document.addEventListener('click', onClick);
    return () => document.removeEventListener('click', onClick);
  }, []);

  return route;
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
