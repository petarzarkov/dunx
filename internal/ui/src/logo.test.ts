import { expect, it } from 'bun:test';
import { LOGO_FAVICON as PUBLISHED } from '@dunx/http/internal';
import { LOGO_FAVICON } from './logo.js';

// A published package cannot import this one, so `@dunx/http` carries a copy of
// the icon the dashboard and the Scalar explorer serve. This is what keeps it the
// mark declared here.
it('matches the copy @dunx/http publishes', () => {
  expect(PUBLISHED).toBe(LOGO_FAVICON);
});
