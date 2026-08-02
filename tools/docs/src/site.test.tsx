import { MantineProvider } from '@mantine/core';
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { App } from './App';
import {
  integer,
  NOISE_PCT,
  scenarioHeadlines,
  scoreboard,
  startupRows,
  throughputRows,
} from './bench';
import { bench, site } from './data';
import { anchoredSymbol, parseRoute, symbolHref } from './router';

const mount = (hash: string) => {
  window.location.hash = hash;
  return render(
    <MantineProvider defaultColorScheme="light">
      <App />
    </MantineProvider>,
  );
};

beforeEach(() => {
  window.location.hash = '';
});

afterEach(() => {
  document.body.innerHTML = '';
});

describe('the generated model', () => {
  test('covers every published package', () => {
    expect(site.packages.map((pkg) => pkg.name).sort()).toEqual([
      '@dunx/auth',
      '@dunx/core',
      '@dunx/create-app',
      '@dunx/http',
      '@dunx/infra',
      '@dunx/openapi',
      '@dunx/testing',
      '@dunx/transform',
    ]);
  });

  test('every package has a rendered readme and a public surface', () => {
    for (const pkg of site.packages) {
      expect(pkg.readme.length).toBeGreaterThan(100);
      expect(
        pkg.symbols.filter((s) => s.subpaths.length > 0).length,
      ).toBeGreaterThan(0);
    }
  });

  test('no readme carries repo-setup sections onto the site', () => {
    const banned =
      /<h2 id="(install|licen[cs]e|contributing|development|building|project-structure|scripts|versioning|packages)/;
    for (const pkg of site.packages) {
      expect(pkg.readme).not.toMatch(banned);
    }
    expect(site.home).not.toMatch(banned);
    // The landing page is the root README minus its plumbing, so the tree, the
    // script table and the badge block must all be gone.
    expect(site.home).not.toContain('bun run install:clean');
    expect(site.home).not.toContain('├──');
    expect(site.home).not.toContain('img.shields.io');
  });

  test('the guides are left whole - they are repo documentation', () => {
    const architecture = site.guides.find((g) => g.slug === 'architecture');
    expect(architecture?.html).toContain('<h2 id="documentation-site');
  });

  test('separates the hand-written tour from the repo reference docs', () => {
    expect(
      site.guides
        .filter((g) => g.category === 'reference')
        .map((g) => g.slug)
        .sort(),
    ).toEqual(['architecture', 'bun-apis', 'migration-from-nest', 'roadmap']);

    const tour = site.guides.filter((g) => g.category === 'guide');
    expect(tour.length).toBeGreaterThan(0);
    // The numeric prefix states the order and is stripped from the slug, so a
    // reorder never changes a URL.
    for (const page of tour) {
      expect(page.slug).not.toMatch(/^\d/);
      expect(page.order).toBeGreaterThan(0);
    }
    expect(tour.map((g) => g.order)).toEqual(
      tour.map((g) => g.order).sort((a, b) => a - b),
    );
  });

  test('every tour page carries a section, and sections are contiguous', () => {
    const tour = site.guides.filter((g) => g.category === 'guide');
    for (const page of tour) expect(page.section).not.toBe('');

    // The nav groups by walking the ordered list, so a section appearing twice
    // would render as two headings with the same name.
    const seen = new Set<string>();
    let previous = '';
    for (const page of tour) {
      if (page.section === previous) continue;
      expect(seen.has(page.section)).toBe(false);
      seen.add(page.section);
      previous = page.section;
    }
    expect(seen.size).toBeGreaterThan(1);
  });

  test('the nav renders a heading per section', () => {
    mount('#/guide/providers');
    // A guide page has two navigation landmarks: the sidebar and the page's own
    // prev/next links. The sidebar is the first, since AppShell renders it before
    // the main content.
    const nav = screen.getAllByRole('navigation')[0];
    if (!nav) throw new Error('no navigation landmark');
    const sections = new Set(
      site.guides.filter((g) => g.category === 'guide').map((g) => g.section),
    );
    for (const section of sections) {
      expect(within(nav).getAllByText(section).length).toBeGreaterThan(0);
    }
  });

  test('the guides carry rendered html and headings', () => {
    for (const guide of site.guides) {
      expect(guide.html).toContain('<h2 id=');
      expect(guide.headings.length).toBeGreaterThan(0);
    }
  });
});

describe('the benchmark model', () => {
  test('is either a schema-1 report or explicitly absent', () => {
    expect(bench === null || bench.schemaVersion === 1).toBe(true);
  });

  test.if(bench !== null)('ranks every subject in every scenario', () => {
    if (!bench) return;
    for (const scenario of bench.scenarios) {
      const rows = throughputRows(bench, scenario.id);
      expect(rows).toHaveLength(bench.subjects.length);
      // Ordered by measured throughput and nothing else.
      for (let i = 1; i < rows.length; i += 1) {
        expect(rows[i - 1]?.rps).toBeGreaterThanOrEqual(rows[i]?.rps ?? 0);
      }
      expect(rows.some((row) => row.id === 'dunx')).toBe(true);
      expect(rows.some((row) => row.pctOfBaseline === 100)).toBe(true);
    }
    expect(startupRows(bench)).toHaveLength(bench.subjects.length);
    expect(scenarioHeadlines(bench)).toHaveLength(bench.scenarios.length);
  });

  test.if(bench !== null)('prints its measured numbers on the page', () => {
    if (!bench) return;
    const scenario = bench.scenarios[0];
    if (!scenario) return;
    const rows = throughputRows(bench, scenario.id);
    const dunx = rows.find((row) => row.id === 'dunx');
    if (!dunx) return;

    mount('#/benchmarks');
    const text = document.body.textContent ?? '';
    expect(text).toContain(integer(dunx.rps));
    expect(text).toContain(bench.machine.cpuModel);
    expect(text).toContain('Where dunx loses');
  });

  test.if(bench !== null)('summarises on the landing page', () => {
    if (!bench) return;
    mount('#/');
    expect(document.body.textContent).toContain('raw ');
    expect(screen.getAllByText(/See the full results/).length).toBe(1);
  });

  test.if(bench !== null)('reads the scoreboard off the run', () => {
    if (!bench) return;
    const board = scoreboard(bench);
    expect(board.ahead + board.tied + board.behind).toBe(board.total);
    expect(board.total).toBe(bench.scenarios.length);

    for (const scenario of scenarioHeadlines(bench)) {
      const gap = scenario.focusPct - scenario.rivalPct;
      expect(scenario.verdict).toBe(
        Math.abs(gap) <= NOISE_PCT ? 'tied' : gap > 0 ? 'ahead' : 'behind',
      );
    }
  });

  test.if(bench !== null)(
    'never claims a clean sweep the run does not show',
    () => {
      if (!bench) return;
      const board = scoreboard(bench);
      mount('#/benchmarks');
      const text = document.body.textContent ?? '';
      expect(text).toContain(`${board.ahead}W ${board.tied}T ${board.behind}L`);
      // Cold start is a loss, and the page has to keep saying so.
      expect(text).toContain('Cold start');
    },
  );
});

describe('the landing page', () => {
  test('leads with dependency injection that needs no decorators', () => {
    mount('#/');
    const text = document.body.textContent ?? '';
    expect(text).toContain(
      'constructor(private readonly repo: UsersRepository)',
    );
    expect(text).toContain('preload = ["@dunx/transform/preload"]');
    expect(text).toContain('reflect-metadata');
  });

  test('states the measurable claims and links every package to npm', () => {
    mount('#/');
    const text = document.body.textContent ?? '';
    expect(text).toContain('zero dependencies');
    expect(text).toContain('Bun.serve');
    expect(text).toContain('Bun.password');
    expect(text).toContain(`${site.packages.length} packages`);

    // By href rather than by the link text: the footer also links the npm org,
    // so counting the word "npm" counts one link that is not a package.
    const npmLinks = screen
      .getAllByRole('link')
      .map((link) => link.getAttribute('href') ?? '')
      .filter((url) => url.startsWith('https://www.npmjs.com/package/'));
    expect(new Set(npmLinks).size).toBe(site.packages.length);
  });

  test.if(bench !== null)(
    'prices request logging instead of only advertising it',
    () => {
      if (!bench) return;
      const plaintext = scenarioHeadlines(bench)[0];
      if (plaintext?.loggingPct == null) return;
      mount('#/');
      expect(document.body.textContent).toContain(
        `${plaintext.loggingPct.toFixed(1)}%`,
      );
    },
  );
});

describe('navigation', () => {
  test('the landing page lists the packages', () => {
    mount('#/');
    const nav = screen.getByRole('navigation');
    for (const pkg of site.packages) {
      expect(within(nav).getAllByText(pkg.name).length).toBeGreaterThan(0);
    }
    expect(screen.getAllByText('dunx').length).toBeGreaterThan(0);
  });

  test('a guide route renders the markdown that Bun produced', () => {
    mount('#/guide/architecture');
    const headings = screen.getAllByRole('heading', { level: 1 });
    expect(headings[0]?.textContent).toContain('Architecture');
    // The document's own `# Title` is dropped, so the page shows exactly one h1.
    expect(headings).toHaveLength(1);
    expect(document.querySelector('.prose')?.innerHTML ?? '').toContain(
      '<h2 id=',
    );
  });

  test('a package route renders its readme and its API reference', async () => {
    mount('#/api/core');
    expect(screen.getAllByText('@dunx/core').length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole('tab', { name: /API reference/i }));
    await screen.findByText(/symbols$/);

    expect(screen.getAllByText('AppFactory').length).toBeGreaterThan(0);
    expect(document.body.textContent).toContain('class AppFactory');
  });

  test('an unknown route falls through to Not found', () => {
    mount('#/api/nope');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(
      'Not found',
    );
  });

  test('benchmarks lead the navigation', () => {
    mount('#/');
    const links = within(screen.getByRole('navigation')).getAllByRole('link');
    expect(links[0]?.textContent).toContain('Benchmarks');
  });

  test('the benchmarks page renders whatever model the build had', () => {
    mount('#/benchmarks');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(
      'Benchmarks',
    );
  });

  test('the coverage page renders whatever model the build had', () => {
    mount('#/coverage');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(
      'Coverage',
    );
  });
});

/**
 * Reported: search `Logger`, click the `ConsoleLogger` hit, and the page that
 * opens is `@dunx/core`'s readme with no mention of the symbol. Two causes -
 * the action navigated to the bare package route with no `?h=`, and the API tab
 * that holds the cards is not the one a package page opens on.
 */
describe('a symbol search hit', () => {
  const scrolled: string[] = [];

  beforeEach(() => {
    scrolled.length = 0;
    Element.prototype.scrollIntoView = function scrollIntoView(
      this: Element,
    ): void {
      scrolled.push(this.id);
    };
  });

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

    const card = await waitFor(() => {
      const found = document.getElementById('symbol-ConsoleLogger');
      if (!found) throw new Error('symbol card not rendered');
      return found;
    });

    expect(card.getAttribute('data-linked')).toBe('true');
    expect(card.textContent).toContain('class ConsoleLogger extends Logger');
    expect(document.querySelectorAll('[data-linked="true"]')).toHaveLength(1);
  });

  test('scrolls the card into view', async () => {
    mount('#/api/core?h=symbol-ConsoleLogger');
    await waitFor(() => {
      if (!scrolled.includes('symbol-ConsoleLogger')) {
        throw new Error(`scrolled: ${scrolled.join(',')}`);
      }
    });
  });

  test('reaches a symbol the filters would otherwise hide', async () => {
    const internal = site.packages
      .find((pkg) => pkg.dir === 'core')
      ?.symbols.find((symbol) => symbol.subpaths.length === 0);
    if (!internal) throw new Error('no internal symbol in @dunx/core');

    mount(`#/api/core?h=symbol-${internal.name}`);
    await waitFor(() => {
      if (!document.getElementById(`symbol-${internal.name}`)) {
        throw new Error('internal symbol hidden behind the Internal switch');
      }
    });
  });

  test('lands on the symbol when the package page is already open', async () => {
    mount('#/api/core');
    await screen.findByRole('tab', { name: /API reference/i });
    expect(document.getElementById('symbol-ConsoleLogger')).toBe(null);

    window.location.hash = '#/api/core?h=symbol-ConsoleLogger';
    fireEvent(window, new window.HashChangeEvent('hashchange'));

    await waitFor(() => {
      const card = document.getElementById('symbol-ConsoleLogger');
      if (!card) throw new Error('symbol card not rendered after navigation');
      expect(card.getAttribute('data-linked')).toBe('true');
    });
  });
});
