import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mount } from './harness';
import {
  integer,
  NOISE_PCT,
  scenarioHeadlines,
  scoreboard,
  startupRows,
  throughputRows,
} from './bench';
import { bench, loadGuide, loadPackage, site } from './data';

beforeEach(() => {
  window.history.replaceState(null, '', '/');
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
      '@dunx/dashboard',
      '@dunx/http',
      '@dunx/infra',
      '@dunx/mcp',
      '@dunx/openapi',
      '@dunx/testing',
      '@dunx/transform',
    ]);
  });

  test('every package has a rendered readme and a public surface', async () => {
    for (const pkg of site.packages) {
      const body = await loadPackage(pkg.dir);
      expect(body?.readme.length).toBeGreaterThan(100);
      expect(pkg.exports.length).toBeGreaterThan(0);
    }
  });

  test('no readme carries repo-setup sections onto the site', async () => {
    const banned =
      /<h2 id="(install|licen[cs]e|contributing|development|building|project-structure|scripts|versioning|packages)/;
    for (const pkg of site.packages) {
      expect((await loadPackage(pkg.dir))?.readme).not.toMatch(banned);
    }
  });

  test('the guides are left whole - they are repo documentation', async () => {
    // `siteMarkdown` strips repo-plumbing sections out of a package README. A
    // guide is not a README and must arrive with every section it was written
    // with, including the ones whose headings match that list.
    const testing = await loadGuide('testing');
    expect(testing?.html).toContain('<h2 id="sharp-edges');
  });

  /**
   * The site publishes a list, not a glob: `docs/` also holds the maintainer's
   * decision record, the roadmap and the Bun API notes, and shipping those put an
   * engineering notebook in the reader's path. A page dropped from
   * `PUBLISHED_REFERENCE` must leave no in-site link behind it - `rewriteHref`
   * turns those into absolute GitHub links, and `links.test.tsx` proves it.
   */
  test('the notebook pages are not published', () => {
    const slugs = new Set(site.guides.map((guide) => guide.slug));
    for (const slug of [
      'roadmap',
      'bun-apis',
      'architecture',
      'architecture-benchmarks',
      'architecture-packaging',
      'architecture-cost-of-logging',
      'architecture-constraints',
      'architecture-tooling',
    ]) {
      expect(slugs).not.toContain(slug);
    }
    expect(slugs).toContain('architecture-dependency-injection');
    expect(slugs).toContain('migration-from-nest');
  });

  test('no two guides share a slug', () => {
    const slugs = site.guides.map((guide) => guide.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  /**
   * The whole model used to be one `site.json` in the entry chunk, so `/`
   * downloaded 21 guide bodies and eight package readmes to render a page that
   * shows none of them. The index must keep carrying what the shell and the
   * search reach for, and nothing that only a route reads.
   */
  test('the index carries the search surface and no page bodies', () => {
    expect(JSON.stringify(site).length).toBeLessThan(120_000);
    expect(site.guides.length).toBeGreaterThan(15);
    for (const guide of site.guides) {
      expect(guide.title).not.toBe('');
      expect(guide.headings.length).toBeGreaterThan(0);
      expect(guide).not.toHaveProperty('html');
    }
    for (const pkg of site.packages) {
      expect(pkg).not.toHaveProperty('readme');
      expect(pkg).not.toHaveProperty('symbols');
      for (const symbol of pkg.exports) expect(symbol.name).not.toBe('');
    }
  });

  test('every index entry has a body chunk behind it', async () => {
    for (const guide of site.guides) {
      expect((await loadGuide(guide.slug))?.html).toContain('<h2 id=');
    }
    for (const pkg of site.packages) {
      expect((await loadPackage(pkg.dir))?.symbols.length).toBeGreaterThan(0);
    }
    expect(await loadGuide('no-such-guide')).toBeUndefined();
    expect(await loadPackage('no-such-package')).toBeUndefined();
  });

  test('separates the hand-written tour from the repo reference docs', () => {
    const reference = site.guides
      .filter((g) => g.category === 'reference')
      .map((g) => g.slug)
      .sort();

    // The published reference set is a list in `generate.ts`, not a glob, so this
    // is a frozen list on purpose: adding a page to the site is a decision about
    // the reader's main path and should show up in a diff here.
    expect(reference.filter((s) => !s.startsWith('architecture-'))).toEqual([
      'migration-from-nest',
    ]);
    // Two: the pages that explain the shape of the public API. The rest of
    // `docs/architecture/` is a decision record and stays in the repository.
    expect(reference.filter((s) => s.startsWith('architecture-'))).toEqual([
      'architecture-dependency-injection',
      'architecture-http',
    ]);

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
    mount('/guide/providers');
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

    mount('/benchmarks');
    const text = document.body.textContent ?? '';
    expect(text).toContain(integer(dunx.rps));
    expect(text).toContain(bench.machine.cpuModel);
    expect(text).toContain('How to read this');
  });

  test.if(bench !== null)('summarises on the landing page', () => {
    if (!bench) return;
    mount('/');
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
      mount('/benchmarks');
      const text = document.body.textContent ?? '';
      expect(text).toContain(`${board.ahead}W ${board.tied}T ${board.behind}L`);
      // Cold start is a loss, and the page has to keep saying so.
      expect(text).toContain('Cold start');
    },
  );
});

describe('the landing page', () => {
  test('leads with dependency injection that needs no decorators', () => {
    mount('/');
    const text = document.body.textContent ?? '';
    expect(text).toContain(
      'constructor(private readonly repo: UsersRepository)',
    );
    expect(text).toContain('preload = ["@dunx/transform/preload"]');
    expect(text).toContain('reflect-metadata');
  });

  test('states the measurable claims and links every package to npm', () => {
    mount('/');
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
      mount('/');
      expect(document.body.textContent).toContain(
        `${plaintext.loggingPct.toFixed(1)}%`,
      );
    },
  );
});

describe('navigation', () => {
  test('the landing page lists the packages', () => {
    mount('/');
    const nav = screen.getByRole('navigation');
    for (const pkg of site.packages) {
      expect(within(nav).getAllByText(pkg.name).length).toBeGreaterThan(0);
    }
    expect(screen.getAllByText('dunx').length).toBeGreaterThan(0);
  });

  test('a guide route renders the markdown that Bun produced', async () => {
    mount('/guide/migration-from-nest');
    const headings = screen.getAllByRole('heading', { level: 1 });
    expect(headings[0]?.textContent).toContain('Migrating from NestJS');
    // The document's own `# Title` is dropped, so the page shows exactly one h1.
    expect(headings).toHaveLength(1);
    // The title comes from the index and the body from the guide's own chunk,
    // so the frame is on screen a tick before the prose is.
    await waitFor(() => {
      expect(document.querySelector('.prose')?.innerHTML ?? '').toContain(
        '<h2 id=',
      );
    });
  });

  test('a package route renders its readme and its API reference', async () => {
    mount('/api/core');
    expect(screen.getAllByText('@dunx/core').length).toBeGreaterThan(0);
    await waitFor(() => {
      if (!document.querySelector('.prose')) throw new Error('no readme yet');
    });

    fireEvent.click(screen.getByRole('tab', { name: /API reference/i }));
    await screen.findByText(/symbols$/);

    expect(screen.getAllByText('AppFactory').length).toBeGreaterThan(0);
    expect(document.body.textContent).toContain('class AppFactory');
  });

  test('an unknown route falls through to Not found', () => {
    mount('/api/nope');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(
      'Not found',
    );
  });

  test('benchmarks lead the navigation', () => {
    mount('/');
    const links = within(screen.getByRole('navigation')).getAllByRole('link');
    expect(links[0]?.textContent).toContain('Benchmarks');
  });

  test('the benchmarks page renders whatever model the build had', () => {
    mount('/benchmarks');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(
      'Benchmarks',
    );
  });

  test('the coverage page renders whatever model the build had', () => {
    mount('/coverage');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(
      'Coverage',
    );
  });
});
