import { expect, it } from 'bun:test';

/**
 * The landing page's wiring, checked without booting anything.
 *
 * Its own file rather than beside the other landing assertions in
 * `service.test.ts`, which is at the 800-line cap. Nothing here needs a server:
 * both failures it catches are visible in the two files on disk.
 *
 * The failure it exists for is a panel that renders and does nothing. Every
 * panel is a button in `index.html` and a listener in `landing.js` keyed on the
 * same id string, and nothing but this connects the two: a renamed id leaves a
 * button that looks live and answers no click.
 */
const DIR = new URL('./landing/public/', import.meta.url).pathname;

const read = async (name: string): Promise<string> =>
  Bun.file(`${DIR}${name}`).text();

/** `$('x')` is how the page reaches every element it touches. */
const reached = (script: string): ReadonlySet<string> =>
  new Set([...script.matchAll(/\$\('([^']+)'\)/g)].map((match) => match[1]!));

const declared = (page: string): ReadonlySet<string> =>
  new Set([...page.matchAll(/id="([^"]+)"/g)].map((match) => match[1]!));

it('reaches every element the page declares', async () => {
  const page = declared(await read('index.html'));
  const script = reached(await read('landing.js'));

  // A button with no listener is the half of a panel a reader clicks first.
  expect([...page].filter((id) => !script.has(id))).toEqual([]);
});

it('declares every element the script reaches', async () => {
  const page = declared(await read('index.html'));
  const script = reached(await read('landing.js'));

  // `$()` returns null for a missing id, so this throws on load and takes every
  // panel below it with it, not only the one that moved.
  expect([...script].filter((id) => !page.has(id))).toEqual([]);
});

/**
 * The panels are the demo's whole surface, so losing one silently is the thing
 * worth a number. Raise it when a panel is added; it is here to fail on a
 * deletion nobody meant.
 */
it('keeps every panel the page is counted as having', async () => {
  const page = await read('index.html');
  const panels = [...page.matchAll(/<section\b/g)].length;

  expect(panels).toBeGreaterThanOrEqual(19);
});
