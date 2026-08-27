import { MantineProvider } from '@mantine/core';
import { act, configure, render } from '@testing-library/react';
import { App } from './App';

/**
 * Shared by the site suites: mounting the app at a hash is the setup every one of
 * them needs, and a second copy would drift from the provider configuration the real
 * entry uses.
 *
 * Not a `.test.` file, so `bun test` does not collect it. It lives in `tools/`, which
 * is never published.
 */
export const mount = (hash: string) => {
  window.location.hash = hash;
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
    return body();
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
    constructor(callback: IntersectionObserverCallback) {
      callbacks.push(callback);
    }
    observe(node: Element): void {
      watched.push(node);
    }
    disconnect(): void {
      watched.length = 0;
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
