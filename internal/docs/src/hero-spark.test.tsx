import { describe, expect, test } from 'bun:test';
import { render } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import { Hero } from './components/Hero';
import { withIntersection, withoutIntersection } from './harness';
import { HEADLINE } from '../../../scripts/positioning.js';

const hero = (): HTMLElement =>
  render(
    <MantineProvider>
      <Hero />
    </MantineProvider>,
  ).container;

const titleOf = (): HTMLElement => {
  const title = hero().querySelector('.hero-title');
  if (!(title instanceof HTMLElement)) throw new Error('no .hero-title');
  return title;
};

describe('the hero spark', () => {
  /* `positioning.test.tsx` asserts the heading's text is exactly the shared
     headline, so an element added inside it has to carry none. That test would
     catch this from the other side; this one says why the span is empty. */
  test('is decorative and adds no text to the heading', () => {
    const title = withoutIntersection(titleOf);
    const spark = title.querySelector('.hero-spark');

    expect(spark).not.toBeNull();
    expect(spark?.textContent).toBe('');
    expect(spark?.getAttribute('aria-hidden')).toBe('true');
    expect(title.textContent).toBe(HEADLINE.join(''));
  });

  test('laps while the headline is on screen, and stops when it is not', () => {
    withIntersection(({ fire, watched }) => {
      const title = titleOf();
      expect(watched).toEqual([title]);
      expect(title.dataset['spark']).toBe('false');

      fire(true);
      expect(title.dataset['spark']).toBe('true');

      // The lap repeats for as long as the page is open, so scrolling past the
      // headline has to end it rather than leave it running behind the page.
      fire(false);
      expect(title.dataset['spark']).toBe('false');
    });
  });

  test('laps anyway where there is no observer to ask', () => {
    expect(withoutIntersection(titleOf).dataset['spark']).toBe('true');
  });
});
