import { MantineProvider } from '@mantine/core';
import { StrictMode } from 'react';
import { createRoot, hydrateRoot } from 'react-dom/client';
import '@mantine/core/styles.css';
import '@mantine/charts/styles.css';
import '@mantine/spotlight/styles.css';
import '@dunx/ui/styles.css';
import './styles.css';
import './landing.css';
import './generated/shiki.css';
import { theme } from '@dunx/ui';
import { App } from './App';
import { seedProse } from './data';

const container = document.getElementById('root');
if (!container) throw new Error('#root is missing from index.html');

/**
 * The prose the built page was rendered with, taken out of the document.
 *
 * It came from a 65 KB chunk this bundle has not fetched, and `useChunk` would
 * otherwise draw the skeleton on the first render and throw the rendered guide
 * away. Inlining the chunk as JSON was measured at +11.9 KB gzipped a page; the
 * markup is already here, so the element's own `innerHTML` is the payload and
 * `data-prose-seed` names the chunk. See `data.ts`.
 */
for (const element of container.querySelectorAll('[data-prose-seed]')) {
  seedProse(element.getAttribute('data-prose-seed') ?? '', element.innerHTML);
}

const tree = (
  <StrictMode>
    <MantineProvider theme={theme} defaultColorScheme="auto">
      <App />
    </MantineProvider>
  </StrictMode>
);

/**
 * `hydrateRoot` against a built page, `createRoot` against an empty shell.
 *
 * `bun run docs:dev` serves `index.html` with nothing in `#root`, and so does
 * and the dev server renders no pages, so the mode is read off the container
 * rather than assumed.
 */
if (container.firstChild) hydrateRoot(container, tree);
else createRoot(container).render(tree);
