import { MantineProvider } from '@mantine/core';
import { act, configure, render } from '@testing-library/react';
import { App } from './App';

/**
 * Shared by the site suites: mounting the app at a path is the setup every one of
 * them needs, and a second copy would drift from the provider configuration the real
 * entry uses.
 *
 * `replaceState` rather than an assignment, since the router reads
 * `location.pathname` and that is not writable.
 *
 * Not a `.test.` file, so `bun test` does not collect it. It lives in `tools/`, which
 * is never published.
 */
export const mount = (path: string) => {
  window.history.replaceState(null, '', path);
  return render(
    <MantineProvider defaultColorScheme="light">
      <App />
    </MantineProvider>,
  );
};

/**
 * The scroll flake is fixed by driving animation frames directly - see
 * `symbol-anchor.test.tsx`. This covers the rest: every `waitFor` in these suites
 * mounts the whole app, and `bun run --filter '*' test` runs fourteen workspaces at
 * once, so a React render against testing-library's 1000 ms default is tighter than
 * it looks. A passing wait still returns the moment its condition holds; only a real
 * failure takes longer to report.
 */
configure({ asyncUtilTimeout: 5_000 });

/** What a suite drives a stubbed observer with. */
export interface Intersection {
  /** Reports an intersection to every observer the render subscribed. A property
      rather than a method, so a suite can destructure it. */
  readonly fire: (isIntersecting: boolean) => void;
  /** The elements handed to `observe`, in subscription order. */
  readonly watched: readonly Element[];
}

const swap = <T,>(stub: unknown, body: () => T): T => {
  const real = globalThis.IntersectionObserver;
  globalThis.IntersectionObserver = stub as typeof IntersectionObserver;
  try {
    const result = body();
    // The real observer goes back when this returns, so an async body would run
    // its assertions against a stub that is no longer installed and fail somewhere
    // unrelated. Checked here rather than in the signature: inference through an
    // `Exclude<T, Promise<unknown>>` parameter collapses T to `unknown` and takes
    // every caller's return type with it.
    const thenable = result as unknown as { then?: unknown } | null;
    if (typeof thenable?.then === 'function') {
      throw new Error(
        'the body must be synchronous: the real IntersectionObserver is restored when it returns',
      );
    }
    return result;
  } finally {
    globalThis.IntersectionObserver = real;
  }
};

/**
 * Renders with an IntersectionObserver a suite can drive.
 *
 * happy-dom ships one that never reports, so a component keyed off the viewport
 * sits in its initial state forever and a test of what it does when a section
 * arrives or leaves has to supply the events itself.
 */
export const withIntersection = <T,>(body: (io: Intersection) => T): T => {
  const callbacks: IntersectionObserverCallback[] = [];
  const watched: Element[] = [];

  class Stub {
    constructor(private readonly callback: IntersectionObserverCallback) {
      callbacks.push(callback);
    }

    observe(node: Element): void {
      watched.push(node);
    }

    /**
     * Drops its own callback, and nothing else. `useReveal` disconnects on unmount,
     * so a `fire` after that would push state into an unmounted tree: an `act`
     * warning at best, a pass that means nothing at worst. `watched` is left alone,
     * being the record of what was observed rather than what is still live.
     */
    disconnect(): void {
      const at = callbacks.indexOf(this.callback);
      if (at !== -1) callbacks.splice(at, 1);
    }
  }

  const fire = (isIntersecting: boolean): void => {
    if (callbacks.length === 0) {
      throw new Error('nothing subscribed an IntersectionObserver');
    }
    act(() => {
      for (const callback of callbacks) {
        callback(
          [{ isIntersecting }] as unknown as IntersectionObserverEntry[],
          {} as IntersectionObserver,
        );
      }
    });
  };

  return swap(Stub, () => body({ fire, watched }));
};

/**
 * Renders with the API absent, which is a real browser that does not implement it.
 * Anything gated on the viewport has to arrive in its final state there rather than
 * waiting for an event that can never come.
 */
export const withoutIntersection = <T,>(body: () => T): T =>
  swap(undefined, body);
