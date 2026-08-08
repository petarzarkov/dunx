import { useEffect, useState } from 'react';

/**
 * Hash routing, so the page needs no server route per panel.
 *
 * The mount already serves the page for **any** non-`api` path under it, so a real
 * path would work too - but a hash keeps every URL the page produces inert to the
 * proxy in front of it, and a dashboard is exactly the thing likely to be behind
 * one that rewrites paths.
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

export interface Route {
  readonly panel: Panel;
  /** The queue a jobs view is scoped to, from `#/queues/emails`. */
  readonly queue: string | undefined;
}

export const parseHash = (hash: string): Route => {
  const [head, tail] = hash.replace(/^#\/?/, '').split('/');
  const panel = (PANELS as readonly string[]).includes(head ?? '')
    ? (head as Panel)
    : 'overview';
  return { panel, queue: tail === '' ? undefined : tail };
};

export const hrefFor = (panel: Panel, queue?: string): string =>
  queue === undefined
    ? `#/${panel}`
    : `#/${panel}/${encodeURIComponent(queue)}`;

export const useRoute = (): Route => {
  const [route, setRoute] = useState(() => parseHash(window.location.hash));

  useEffect(() => {
    const onChange = (): void => setRoute(parseHash(window.location.hash));
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);

  return route;
};
