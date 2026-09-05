import { act, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test } from 'bun:test';
import { mount } from './harness';
import { href, navigate, parseRoute, RouteKind } from './router';

beforeEach(() => {
  window.history.replaceState(null, '', '/');
});

/** Cancelable and dispatched by hand, so `defaultPrevented` is readable. */
const click = (element: Element, init: MouseEventInit = {}): MouseEvent => {
  const event = new window.MouseEvent('click', {
    bubbles: true,
    cancelable: true,
    button: 0,
    ...init,
  });
  act(() => {
    element.dispatchEvent(event);
  });
  return event;
};

const linkTo = (route: string): Element => {
  const link = document.querySelector(`a[href="${route}"]`);
  if (!link) throw new Error(`no link to ${route} on the page`);
  return link;
};

describe('parseRoute', () => {
  test('the root is home', () => {
    expect(parseRoute('/')).toEqual({
      kind: RouteKind.Home,
      slug: '',
      anchor: null,
    });
  });

  test('a trailing slash is the same route', () => {
    expect(parseRoute('/guide/controllers/')).toEqual(
      parseRoute('/guide/controllers'),
    );
  });

  test('`?h=` is the anchor, not part of the slug', () => {
    expect(parseRoute('/guide/controllers?h=nesting')).toEqual({
      kind: RouteKind.Guide,
      slug: 'controllers',
      anchor: 'nesting',
    });
  });

  test('an unknown head is not found, keeping the path it was asked for', () => {
    expect(parseRoute('/nope/what')).toEqual({
      kind: RouteKind.NotFound,
      slug: 'nope/what',
      anchor: null,
    });
  });

  test('every href it produces parses back to the route it names', () => {
    for (const kind of [
      RouteKind.Home,
      RouteKind.Bench,
      RouteKind.Coverage,
      RouteKind.Releases,
    ]) {
      expect(parseRoute(href(kind)).kind).toBe(kind);
    }
    expect(parseRoute(href(RouteKind.Guide, 'controllers'))).toMatchObject({
      kind: RouteKind.Guide,
      slug: 'controllers',
    });
  });
});

/**
 * The delegated listener in `useRoute`, which is what replaced `hashchange`.
 * Nothing else on the site calls `navigate` for an ordinary link: every one of
 * them is a plain `<a href>` that this has to intercept.
 */
describe('link clicks', () => {
  test('an internal link navigates without leaving the page', async () => {
    mount('/');

    const event = click(linkTo(href(RouteKind.Bench)));

    expect(event.defaultPrevented).toBe(true);
    expect(window.location.pathname).toBe('/benchmarks');
    await waitFor(() => {
      expect(screen.getByRole('heading', { level: 1 }).textContent).toContain(
        'Benchmark',
      );
    });
  });

  /**
   * Only `defaultPrevented` is asserted. In a real browser a cmd-click opens a
   * tab and leaves the page alone; happy-dom has no tabs and navigates on any
   * click the listener does not cancel, so the location afterwards says nothing
   * about whether the router kept its hands off.
   */
  test('a modified click is left to the browser', () => {
    mount('/');

    for (const modifier of [
      { metaKey: true },
      { ctrlKey: true },
      { shiftKey: true },
      { altKey: true },
      { button: 1 },
    ]) {
      window.history.replaceState(null, '', '/');

      expect(
        click(linkTo(href(RouteKind.Bench)), modifier).defaultPrevented,
      ).toBe(false);
    }
  });

  test('a link off the site is left to the browser', () => {
    mount('/');
    const external = document.querySelector('a[href^="https://"]');
    if (!external) throw new Error('no external link on the landing page');

    expect(click(external).defaultPrevented).toBe(false);
  });

  test('back and forward move between routes', async () => {
    mount('/');

    act(() => navigate(href(RouteKind.Coverage)));
    expect(window.location.pathname).toBe('/coverage');

    // `popstate` is the browser's; `navigate` fires its own event because
    // `pushState` fires nothing. Both have to reach the same listener.
    act(() => {
      window.history.replaceState(null, '', href(RouteKind.Bench));
      window.dispatchEvent(new window.Event('popstate'));
    });

    await waitFor(() => {
      expect(screen.getByRole('heading', { level: 1 }).textContent).toContain(
        'Benchmark',
      );
    });
  });

  test('navigating to the route already open adds no history entry', () => {
    mount('/coverage');
    const { length } = window.history;

    act(() => navigate('/coverage'));

    expect(window.history.length).toBe(length);
  });
});
