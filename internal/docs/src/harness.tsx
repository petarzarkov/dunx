import { MantineProvider } from '@mantine/core';
import { configure, render } from '@testing-library/react';
import { App } from './App';

/**
 * Shared by the site suites: mounting the app at a hash is the setup every one of
 * them needs, and a second copy would drift from the provider configuration the real
 * entry uses.
 *
 * Not a `.test.` file, so `bun test` does not collect it. It lives in `tools/`, which
 * is never published.
 */
export const mount = (hash: string) => {
  window.location.hash = hash;
  return render(
    <MantineProvider defaultColorScheme="light">
      <App />
    </MantineProvider>,
  );
};

/**
 * The scroll flake is fixed by driving animation frames directly - see
 * `symbol-anchor.test.tsx`. This covers the rest: every `waitFor` in these suites
 * mounts the whole app, and `bun run --filter '*' test` runs fourteen workspaces at
 * once, so a React render against testing-library's 1000 ms default is tighter than
 * it looks. A passing wait still returns the moment its condition holds; only a real
 * failure takes longer to report.
 */
configure({ asyncUtilTimeout: 5_000 });
