import { useEffect, useState } from 'react';

/**
 * **Real paths, not a hash.**
 *
 * `internal/docs` hash-routes because it is a static site on GitHub Pages, where
 * the server will not answer `/guide/modules` with `index.html`. The dashboard has
 * no such constraint: it is served by the app's own `Bun.serve`, and the mount
 * already answers **any** non-`api`, non-`queues` path under it with the page. So
 * `/_dunx/routes` is a real URL that survives a reload, is bookmarkable, and shows
 * up in a proxy log as the thing it is.
 *
 * Everything is relative to the mount the server embedded in the meta, never to a
 * path this file assumes. An app behind a proxy at `/admin/_dunx` is the normal
 * case, and `basePath` is what makes it work.
 */
export const PANELS = [
  'overview',
  'routes',
  'gateways',
  'graph',
  'queues',
  'config',
] as const;

export type Panel = (typeof PANELS)[number];

const isPanel = (value: string): value is Panel =>
  (PANELS as readonly string[]).includes(value);

/**
 * The first segment after the mount. Anything unrecognised is the overview rather
 * than a 404: the server already decided this path belongs to the dashboard, so
 * the page's job is to show something useful, not to argue about it.
 */
export const panelFor = (pathname: string, basePath: string): Panel => {
  const rest = pathname.startsWith(basePath)
    ? pathname.slice(basePath.length)
    : pathname;
  const [head = ''] = rest.split('/').filter(Boolean);
  return isPanel(head) ? head : 'overview';
};

export const hrefFor = (panel: Panel, basePath: string): string =>
  panel === 'overview' ? basePath || '/' : `${basePath}/${panel}`;

/**
 * `pushState` plus a `popstate` listener, which is the whole router.
 *
 * The click handler is on each link rather than delegated: a plain `<a href>` has
 * to keep working - middle-click, open-in-new-tab, and a full navigation if
 * JavaScript fails - so the anchor stays real and only a plain left-click is
 * intercepted.
 */
export const useRoute = (
  basePath: string,
): { panel: Panel; navigate: (panel: Panel) => void } => {
  const [pathname, setPathname] = useState(() => window.location.pathname);

  useEffect(() => {
    const onPop = (): void => setPathname(window.location.pathname);
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const navigate = (panel: Panel): void => {
    const href = hrefFor(panel, basePath);
    if (href === window.location.pathname) return;
    window.history.pushState(null, '', href);
    setPathname(href);
  };

  return { panel: panelFor(pathname, basePath), navigate };
};

/** True for a click a router may take over: plain left-click, no modifier. */
export const isPlainClick = (event: React.MouseEvent): boolean =>
  event.button === 0 &&
  !event.metaKey &&
  !event.ctrlKey &&
  !event.shiftKey &&
  !event.altKey;
