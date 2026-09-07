import { expect, test } from 'bun:test';
import {
  loadGuide,
  loadPackage,
  peekGuide,
  peekPackage,
  seedProse,
} from './data';

/**
 * The seeding `main.tsx` does before hydrating, which is what stops the first
 * client render replacing a rendered page with its skeleton.
 *
 * A package seed is deliberately **partial**: only the readme tab is rendered on
 * a cold load, so the document carries no symbols and the API tab still needs
 * the chunk. A guide seed is the whole body, so its chunk is never fetched.
 */
test('a guide seed answers a peek and stands in for the chunk', async () => {
  // A slug no guide has, because the cache is module state and `bun test` shares
  // one process: seeding a real slug handed `site.test.tsx` this stub instead of
  // the generated body.
  seedProse('guide:seed-fixture', '<p>seeded prose</p>');

  expect(peekGuide('seed-fixture')?.html).toBe('<p>seeded prose</p>');
  // The 65 KB chunk is what the seed exists to avoid fetching, so a load
  // resolves to the seeded body rather than replacing it.
  expect((await loadGuide('seed-fixture'))?.html).toBe('<p>seeded prose</p>');
});

/**
 * The seed used to go into the same cache `loadPackage` reads, so the load
 * resolved with the seed and the API tab was permanently empty - including for
 * a `?h=symbol-*` link, which opens that tab on arrival.
 */
test('a package seed answers a peek but never satisfies the chunk', async () => {
  // A dir no package has. The caches are module state and `bun test` shares one
  // process, so a real dir is already warm by the time this runs whenever
  // `site.test.tsx` got there first - which made asserting the peek here pass
  // locally and fail in CI on a different file order.
  seedProse('package:seed-fixture', '<p>seeded readme</p>');

  const seeded = peekPackage('seed-fixture');
  expect(seeded?.readme).toBe('<p>seeded readme</p>');
  expect(seeded?.symbols).toEqual([]);

  // `load` used to answer from the map the seed was written to and hand back
  // that partial body. Nothing has a `seed-fixture` chunk, so the honest answer
  // is `undefined`.
  expect(await loadPackage('seed-fixture')).toBeUndefined();
});

/** The outcome the bug denied: the API tab has its symbols. */
test('a seeded package still gets its symbols from the chunk', async () => {
  seedProse('package:http', '<p>seeded readme</p>');

  expect((await loadPackage('http'))?.symbols.length).toBeGreaterThan(0);
});

test('an unknown seed kind is ignored rather than cached', () => {
  seedProse('mystery:thing', '<p>x</p>');
  seedProse('', '<p>x</p>');
  expect(peekGuide('thing')).toBeUndefined();
  expect(peekPackage('thing')).toBeUndefined();
});
