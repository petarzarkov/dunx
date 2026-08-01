import { MantineProvider } from '@mantine/core';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { App } from './App';
import { site } from './data';

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
      '@dunx/compiler',
      '@dunx/core',
      '@dunx/http',
      '@dunx/infra',
      '@dunx/openapi',
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

  test('the guides carry rendered html and headings', () => {
    expect(site.guides.map((g) => g.slug).sort()).toEqual([
      'architecture',
      'bun-apis',
      'migration-from-nest',
      'roadmap',
    ]);
    for (const guide of site.guides) {
      expect(guide.html).toContain('<h2 id=');
      expect(guide.headings.length).toBeGreaterThan(0);
    }
  });
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

  test('the coverage page renders whatever model the build had', () => {
    mount('#/coverage');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(
      'Coverage',
    );
  });
});
