import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { loadPackage } from './data';
import { mount } from './harness';
import { anchoredSymbol, parseRoute, symbolHref } from './router';

/**
 * Reported: search `Logger`, click the `ConsoleLogger` hit, and the page that opens
 * is `@dunx/core`'s readme with no mention of the symbol. Two causes - the action
 * navigated to the bare package route with no `?h=`, and the API tab that holds the
 * cards is not the one a package page opens on.
 */
const scrolled: string[] = [];

/**
 * `useScrollTo` chains up to `SCROLL_ATTEMPTS` (30) animation frames, because a card
 * below the fold finishes laying out after the one scroll a single pass would have
 * done. Waiting on that with wall-clock time is what made this suite flaky: ~480 ms
 * of `requestAnimationFrame` at best, and `bun run --filter '*' test` runs every
 * workspace at once, so under contention it blew any timeout.
 *
 * The other half of that contention was this file's own: with no `cleanup()`, every
 * earlier suite left a mounted tree listening for `hashchange`, and this file ran
 * 12.5s behind the other nine against 1.7s alone. Fixed in `happydom.ts`.
 *
 * So the frames are queued instead of scheduled, and `flushFrames` drains them on
 * demand. The timing dependence is gone rather than widened - the same chain still
 * has to call `scrollIntoView` with the right id, and removing the flush fails.
 */
const frames: FrameRequestCallback[] = [];
const realRaf = globalThis.requestAnimationFrame;
const realCancel = globalThis.cancelAnimationFrame;
// Saved unbound on purpose, to put the real method back on the prototype in afterAll.
// oxlint-disable-next-line typescript/unbound-method
const realScroll = Element.prototype.scrollIntoView;

/** Bounded above SCROLL_ATTEMPTS, so a runaway chain fails rather than hangs. */
const flushFrames = (): void => {
  for (let drained = 0; frames.length > 0 && drained < 200; drained += 1) {
    frames.shift()?.(drained);
  }
};

/** The card has to render before the frames run - that is what the chain waits for. */
const awaitCard = async (id: string): Promise<void> => {
  await waitFor(() => {
    if (!document.getElementById(id)) throw new Error(`${id} not rendered`);
  });
};

beforeEach(() => {
  window.location.hash = '';
  scrolled.length = 0;
  frames.length = 0;
  globalThis.requestAnimationFrame = (callback: FrameRequestCallback) =>
    frames.push(callback);
  globalThis.cancelAnimationFrame = (handle: number) => {
    frames.splice(handle - 1, 1);
  };
  Element.prototype.scrollIntoView = function scrollIntoView(
    this: Element,
  ): void {
    scrolled.push(this.id);
  };
});

/** Restored: `bun test` shares one process, so a stub here reaches every later file. */
afterAll(() => {
  globalThis.requestAnimationFrame = realRaf;
  globalThis.cancelAnimationFrame = realCancel;
  Element.prototype.scrollIntoView = realScroll;
});

describe('a symbol search hit', () => {
  test('routes to the symbol, not to the top of its package', () => {
    expect(symbolHref('core', 'ConsoleLogger')).toBe(
      '#/api/core?h=symbol-ConsoleLogger',
    );
    expect(parseRoute('#/api/core?h=symbol-ConsoleLogger')).toEqual({
      kind: 'api',
      slug: 'core',
      anchor: 'symbol-ConsoleLogger',
    });
    expect(anchoredSymbol('symbol-ConsoleLogger')).toBe('ConsoleLogger');
    expect(anchoredSymbol('always-bound-contracts')).toBe(null);
  });

  test('opens the API tab and marks the card on a cold load', async () => {
    mount('#/api/core?h=symbol-ConsoleLogger');
    await awaitCard('symbol-ConsoleLogger');

    const card = document.getElementById('symbol-ConsoleLogger');
    expect(card?.getAttribute('data-linked')).toBe('true');
    expect(card?.textContent).toContain('class ConsoleLogger extends Logger');
    expect(document.querySelectorAll('[data-linked="true"]')).toHaveLength(1);
  });

  test('scrolls the card into view', async () => {
    mount('#/api/core?h=symbol-ConsoleLogger');
    await awaitCard('symbol-ConsoleLogger');

    flushFrames();
    expect(scrolled).toContain('symbol-ConsoleLogger');
  });

  test('reaches a symbol the filters would otherwise hide', async () => {
    const internal = (await loadPackage('core'))?.symbols.find(
      (symbol) => symbol.subpaths.length === 0,
    );
    if (!internal) throw new Error('no internal symbol in @dunx/core');

    mount(`#/api/core?h=symbol-${internal.name}`);
    await awaitCard(`symbol-${internal.name}`);
  });

  test('lands on the symbol when the package page is already open', async () => {
    mount('#/api/core');
    await screen.findByRole('tab', { name: /API reference/i });
    expect(document.getElementById('symbol-ConsoleLogger')).toBe(null);

    window.location.hash = '#/api/core?h=symbol-ConsoleLogger';
    fireEvent(window, new window.HashChangeEvent('hashchange'));

    await awaitCard('symbol-ConsoleLogger');
    expect(
      document
        .getElementById('symbol-ConsoleLogger')
        ?.getAttribute('data-linked'),
    ).toBe('true');

    // Navigating to an anchor scrolls too, not only a cold load.
    flushFrames();
    expect(scrolled).toContain('symbol-ConsoleLogger');
  });
});
