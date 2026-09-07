import { useEffect, useState } from 'react';

/**
 * A per-route chunk as a value that is `undefined` until it arrives.
 *
 * Deliberately not Suspense: the shell already knows the page's title, source
 * link and headings from the index, so the frame can render immediately and fill
 * the body in. A Suspense boundary would blank all of that instead.
 *
 * Keyed by `key` rather than by the loader, which is a new closure every render.
 * The late-arrival guard matters on a fast hash change: two loads are in flight
 * and the slower one must not overwrite the route that is now current.
 *
 * `peek` is what makes the server-rendered page hold still. The build renders
 * each page with its chunk already loaded, and `main.tsx` files the prose back
 * into the same cache out of the document's own markup before hydrating, so a
 * synchronous read here draws the body React is looking at rather than the
 * skeleton - which would otherwise replace a rendered guide on its first client
 * render. The real chunk is still fetched: for a package page the seed carries
 * the readme and no symbols, and the fetch is what fills the API tab in.
 */
export const useChunk = <T>(
  load: () => Promise<T | undefined>,
  key: string,
  peek?: () => T | undefined,
): T | undefined => {
  const [value, setValue] = useState<T | undefined>(() => peek?.());

  useEffect(() => {
    let current = true;
    setValue(peek?.());
    void load().then((next) => {
      // A seeded value is never dropped for the `undefined` a missing chunk
      // resolves to.
      if (current && next !== undefined) setValue(next);
    });
    return () => {
      current = false;
    };
    // `load` and `peek` are not dependencies, which is the whole point of `key`:
    // both are new closures on every render, so including them would re-run this
    // effect on every render and re-fetch the chunk forever.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return value;
};
