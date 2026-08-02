import { test, expect } from 'bun:test';
import { render } from '@testing-library/react';
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
