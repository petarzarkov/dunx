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
 */
export const useChunk = <T>(
  load: () => Promise<T | undefined>,
  key: string,
): T | undefined => {
  const [value, setValue] = useState<T | undefined>(undefined);

  useEffect(() => {
    let current = true;
    setValue(undefined);
    void load().then((next) => {
      if (current) setValue(next);
    });
    return () => {
      current = false;
    };
  }, [key]);

  return value;
};
