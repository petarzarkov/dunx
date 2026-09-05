import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BLURB, CHIPS, HEADLINE, lead } from '../../../scripts/positioning.js';
import { mount } from './harness';

/**
 * The hero and the README's opening are the same claim to the same reader, and
 * they were two hand-written copies. They drifted inside one release: the README
 * led with what dunx bundles while the hero still led with dependency injection
 * over a throughput panel.
 *
 * `scripts/positioning.ts` is the source now. `bun run gen:readme --check` holds
 * the README to it in CI, and this holds the hero, so neither can be edited back
 * to a literal without something failing.
 */
const README = readFileSync(
  join(import.meta.dir, '..', '..', '..', 'README.md'),
  'utf8',
);

describe('positioning', () => {
  test('the hero renders the shared headline, blurb and chips', () => {
    const { container, getByRole } = mount('/');

    expect(getByRole('heading', { level: 1 }).textContent).toBe(
      HEADLINE.join(''),
    );
    expect(container.textContent).toContain(BLURB);
    for (const chip of CHIPS) {
      expect(container.textContent).toContain(chip);
    }
  });

  test('the README carries the same headline and blurb', () => {
    expect(README).toContain(`**${lead()}**`);
    // Hard-wrapped on the way in, so compare on collapsed whitespace.
    expect(README.replace(/\s+/g, ' ')).toContain(BLURB.replace(/\s+/g, ' '));
  });

  test('the README block is the generated one, not a hand-written copy', () => {
    expect(README).toContain('<!-- positioning:start -->');
    expect(README).toContain('<!-- positioning:end -->');
  });
});
