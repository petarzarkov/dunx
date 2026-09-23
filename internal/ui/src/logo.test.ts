import { expect, it } from 'bun:test';
import { LOGO_FAVICON as PUBLISHED } from '@dunx/http/internal';
import { LOGO_FAVICON } from './logo.js';

// `@dunx/http` carries the icon the dashboard and the Scalar explorer serve,
// written by `bun run gen:logo`. A stale copy fails here, not in a browser tab.
it('matches the copy gen:logo wrote into @dunx/http', () => {
  expect(PUBLISHED, 'run `bun run gen:logo` in internal/ui').toBe(LOGO_FAVICON);
});
