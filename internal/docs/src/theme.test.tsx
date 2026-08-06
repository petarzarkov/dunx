import { MantineProvider } from '@mantine/core';
import { fireEvent, render, screen } from '@testing-library/react';
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test';
import { App } from './App';

/**
 * The colour scheme starts at `auto`, and `auto` is not an answer to "what is on
 * screen". Reading it directly made the toggle's first click a no-op on a dark-OS
 * machine - it set `dark`, which was already showing - so the button had to be
 * pressed twice. These pin both halves of the fix: the toggle resolving `auto`,
 * and `index.html` setting the attribute before the first paint.
 */
const realMatchMedia = Object.getOwnPropertyDescriptor(
  globalThis.window,
  'matchMedia',
);

const prefersDark = (dark: boolean): void => {
  Object.defineProperty(globalThis.window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: dark && query.includes('prefers-color-scheme: dark'),
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }),
  });
};

const scheme = (): string | null =>
  document.documentElement.getAttribute('data-mantine-color-scheme');

const mountAuto = () =>
  render(
    <MantineProvider defaultColorScheme="auto">
      <App />
    </MantineProvider>,
  );

const toggle = (): HTMLElement =>
  screen.getByLabelText(/Switch to the (light|dark) theme/);

beforeEach(() => {
  window.localStorage.clear();
  document.documentElement.removeAttribute('data-mantine-color-scheme');
  window.location.hash = '';
});

afterEach(() => {
  document.body.innerHTML = '';
});

/** `bun test` shares one process, so a stubbed `matchMedia` would leak onwards. */
afterAll(() => {
  if (realMatchMedia) {
    Object.defineProperty(globalThis.window, 'matchMedia', realMatchMedia);
  } else {
    delete (globalThis.window as unknown as Record<string, unknown>)[
      'matchMedia'
    ];
  }
  window.localStorage.clear();
  document.documentElement.removeAttribute('data-mantine-color-scheme');
});

describe('the colour scheme toggle', () => {
  test('switches to light on the first click when the OS is dark', () => {
    prefersDark(true);
    mountAuto();

    expect(scheme()).toBe('dark');
    // The label is what the click will do, so it doubles as the assertion that
    // the button knows a dark page is a dark page.
    expect(toggle().getAttribute('aria-label')).toBe(
      'Switch to the light theme',
    );

    fireEvent.click(toggle());
    expect(scheme()).toBe('light');
  });

  test('switches to dark on the first click when the OS is light', () => {
    prefersDark(false);
    mountAuto();

    expect(scheme()).toBe('light');
    fireEvent.click(toggle());
    expect(scheme()).toBe('dark');
  });

  test('keeps flipping on every click after the first', () => {
    prefersDark(true);
    mountAuto();

    for (const expected of ['light', 'dark', 'light']) {
      fireEvent.click(toggle());
      expect(scheme()).toBe(expected);
    }
  });
});

/**
 * `MantineProvider` sets the attribute on mount, which is after the first paint.
 * The inline script in the document is what stops a dark-OS visitor seeing a light
 * page for a frame, and it is easy to delete by accident because nothing else
 * references it.
 */
describe('the pre-paint colour scheme script', () => {
  const source = async (): Promise<string> => {
    const html = await Bun.file(`${import.meta.dir}/../index.html`).text();
    const match = /<script data-mantine-script>([\s\S]*?)<\/script>/.exec(html);
    if (!match?.[1]) throw new Error('index.html has no colour scheme script');
    return match[1];
  };

  const run = async (): Promise<string | null> => {
    document.documentElement.removeAttribute('data-mantine-color-scheme');
    // Running the document's own script is the point: a copy of it here would
    // pass while index.html was broken, which is the failure being guarded.
    // oxlint-disable-next-line typescript/no-implied-eval
    new Function(await source())();
    return scheme();
  };

  test('resolves an unset scheme against the OS before React mounts', async () => {
    prefersDark(true);
    expect(await run()).toBe('dark');

    prefersDark(false);
    expect(await run()).toBe('light');
  });

  test('honours a stored choice over the OS preference', async () => {
    prefersDark(true);
    window.localStorage.setItem('mantine-color-scheme-value', 'light');
    expect(await run()).toBe('light');
  });

  /** Same storage key `MantineProvider` writes, or the two disagree on reload. */
  test('reads the key the provider writes', async () => {
    prefersDark(false);
    mountAuto();
    fireEvent.click(toggle());

    expect(window.localStorage.getItem('mantine-color-scheme-value')).toBe(
      'dark',
    );
    expect(await run()).toBe('dark');
  });
});
