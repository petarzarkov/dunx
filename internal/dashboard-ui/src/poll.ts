import { useCallback, useEffect, useRef, useState } from 'react';

export interface Async<T> {
  readonly data: T | undefined;
  readonly error: string | undefined;
  readonly loading: boolean;
  readonly refresh: () => void;
}

/**
 * Fetch once, then again every `intervalMs`.
 *
 * Polling rather than a websocket, deliberately. dunx has gateways natively and
 * pushing these numbers would be cheap, but it would put the dashboard's own
 * socket in the app's upgrade table, make the page stateful, and buy latency that
 * "how many jobs are failing" does not need. `pollMs: 0` turns it off and leaves
 * the refresh button, which is the setting for a page left open on a wall.
 *
 * Three things this gets right that a naive `useEffect` + `setInterval` does not,
 * and all three showed up immediately:
 *
 * - **A slow response cannot stack.** The next poll is scheduled when the last one
 *   settles, not on a fixed interval, so a five-second endpoint on a five-second
 *   poll does not open a new request per tick forever.
 * - **A response from a request that has been superseded is dropped**, so switching
 *   queues cannot repaint with the previous queue's jobs.
 * - **`data` survives an error.** A dashboard that blanks every panel because one
 *   poll failed is worse than one showing numbers a few seconds old with the
 *   failure named next to them.
 */
export const usePoll = <T>(
  load: () => Promise<T>,
  intervalMs: number,
  // The identity of `load` changes every render, so the dependency has to be
  // named by the caller: it is what "this is a different query" means here.
  deps: readonly unknown[],
): Async<T> => {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const generation = useRef(0);

  const refresh = useCallback(() => setTick((value) => value + 1), []);

  useEffect(() => {
    const mine = ++generation.current;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;

    const run = async (): Promise<void> => {
      try {
        const next = await load();
        if (stopped || generation.current !== mine) return;
        setData(next);
        setError(undefined);
      } catch (cause) {
        if (stopped || generation.current !== mine) return;
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (!stopped && generation.current === mine) {
          setLoading(false);
          if (intervalMs > 0) timer = setTimeout(() => void run(), intervalMs);
        }
      }
    };

    setLoading(true);
    void run();

    return () => {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, intervalMs, tick]);

  return { data, error, loading, refresh };
};

/** The same, run once: for the snapshot, which cannot change while the process runs. */
export const useOnce = <T>(
  load: () => Promise<T>,
  deps: readonly unknown[] = [],
): Async<T> => usePoll(load, 0, deps);
