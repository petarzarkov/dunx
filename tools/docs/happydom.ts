import { GlobalRegistrator } from '@happy-dom/global-registrator';

/**
 * The site is a browser bundle, so its tests need a DOM before any module under
 * `src/` can load.
 *
 * This used to also carry a plugin teaching Bun Vite's `?raw` suffix. Dropping
 * Vite dropped the need: the generated model is imported with the standard
 * `with { type: 'text' }` attribute, which Bun understands natively.
 */
GlobalRegistrator.register({ url: 'http://localhost/' });
