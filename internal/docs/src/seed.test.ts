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
  seedProse('package:http', '<p>seeded readme</p>');

  const seeded = peekPackage('http');
  expect(seeded?.readme).toBe('<p>seeded readme</p>');
  expect(seeded?.symbols).toEqual([]);

  const loadedBody = await loadPackage('http');
  expect(loadedBody?.symbols.length).toBeGreaterThan(0);
  expect(loadedBody?.readme).not.toBe('<p>seeded readme</p>');

  // And the loaded chunk is what a later peek sees, so navigating away and back
  // does not fall back to the partial one - which is also what keeps this test
  // from leaving a stub behind for another file in the same process.
  expect(peekPackage('http')?.symbols.length).toBeGreaterThan(0);
});

test('an unknown seed kind is ignored rather than cached', () => {
  seedProse('mystery:thing', '<p>x</p>');
  seedProse('', '<p>x</p>');
  expect(peekGuide('thing')).toBeUndefined();
  expect(peekPackage('thing')).toBeUndefined();
});
