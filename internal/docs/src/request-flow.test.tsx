import { test, expect } from 'bun:test';
import { act, render } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import { RequestFlow } from './components/RequestFlow';

const flow = () =>
  render(
    <MantineProvider>
      <RequestFlow />
    </MantineProvider>,
  ).container;

/* The section's whole claim is that middleware wraps `next()`. Indentation
   alone would look the same and mean nothing, so what is asserted here is
   containment: every layer has to be an ancestor of the handler. */
test('every layer nests around the handler', () => {
  const container = flow();
  const core = container.querySelector('.onion-core');
  expect(core).not.toBeNull();

  const layers = container.querySelectorAll('.onion-layer');
  expect(layers.length).toBe(5);
  for (const layer of layers) expect(layer.contains(core)).toBe(true);
});

test('only the layers that see the response carry a return row', () => {
  // Bun.serve, RequestLoggingMiddleware and the global middleware. Guards and
  // validation are one-directional: they can refuse, not rewrite.
  expect(flow().querySelectorAll('.onion-return').length).toBe(3);
});

/* The outbound half of the pulse is drawn on the layer rather than on the return
   row, and CSS cannot ask whether an element has a particular child. So the flag
   the ring keys off has to agree with the rows: a layer marked as wrapping and
   carrying no return row would light on the way out having claimed it does not see
   the response. */
test('the outbound flag marks exactly the layers with a return row', () => {
  const container = flow();
  const wrapping = [...container.querySelectorAll('.onion-layer')].filter(
    (layer) => (layer as HTMLElement).dataset['wraps'] === 'true',
  );

  expect(wrapping.length).toBe(3);
  for (const layer of wrapping) {
    // Its own return row, not one belonging to a layer nested inside it.
    const own = [...layer.querySelectorAll('.onion-return')].filter(
      (row) => row.closest('.onion-layer') === layer,
    );
    expect(own.length).toBe(1);
  }
});

test('depth ascends inwards, which is what the accent and stagger read', () => {
  const depths = [...flow().querySelectorAll('.onion-layer')].map((layer) =>
    (layer as HTMLElement).style.getPropertyValue('--depth'),
  );
  expect(depths).toEqual(['0', '1', '2', '3', '4']);
});

test('the runtime layer is marked native', () => {
  const native = flow().querySelectorAll('.onion-layer[data-native="true"]');
  expect(native.length).toBe(1);
  expect(native[0]?.textContent).toContain('Bun.serve');
});

/** Swaps the global observer for one body, restoring whatever was there. */
const withObserver = <T,>(stub: unknown, body: () => T): T => {
  const real = globalThis.IntersectionObserver;
  globalThis.IntersectionObserver = stub as typeof IntersectionObserver;
  try {
    return body();
  } finally {
    globalThis.IntersectionObserver = real;
  }
};

const onionOf = (): HTMLElement => {
  const onion = flow().querySelector('.onion');
  if (!(onion instanceof HTMLElement)) throw new Error('no .onion rendered');
  return onion;
};

test('runs the pulse when there is no observer to ask', () => {
  // A browser missing the API has nothing to wait for, so the section has to
  // arrive revealed and animating rather than invisible and still. happy-dom does
  // ship an IntersectionObserver, so this case needs the global taken away.
  const onion = withObserver(undefined, onionOf);

  expect(onion.dataset['revealed']).toBe('true');
  expect(onion.dataset['running']).toBe('true');
});

/* The pulse loops for as long as the page is open, so it has to stop when the
   section is off screen. The entrance stays one-shot: scrolling away and back
   must not replay it. */
test('the pulse follows the viewport while the entrance latches', () => {
  const callbacks: IntersectionObserverCallback[] = [];
  const watched: Element[] = [];
  class Fake {
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
    const callback = callbacks[0];
    if (!callback) throw new Error('the hook subscribed no observer');
    act(() =>
      callback(
        [{ isIntersecting }] as unknown as IntersectionObserverEntry[],
        {} as IntersectionObserver,
      ),
    );
  };

  withObserver(Fake, () => {
    const onion = onionOf();
    expect(watched).toEqual([onion]);
    expect(onion.dataset['running']).toBe('false');

    fire(true);
    expect(onion.dataset['running']).toBe('true');
    expect(onion.dataset['revealed']).toBe('true');

    fire(false);
    expect(onion.dataset['running']).toBe('false');
    expect(onion.dataset['revealed']).toBe('true');
  });
});
