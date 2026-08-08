import { GlobalRegistrator } from '@happy-dom/global-registrator';

/**
 * The dashboard is a browser bundle, so its tests need a DOM before any module
 * under `src/` can load. The URL matters: the page reads its own mount from the
 * embedded meta, and every fetch it makes is relative to it.
 *
 * Deliberately not routed through `@dunx/ui`, for the reason recorded in
 * `internal/openapi-ui/happydom.ts`: a shared module that also imported Testing
 * Library pulled that in *before* the registrator ran, and Testing Library
 * captures `document` at import time.
 */
GlobalRegistrator.register({ url: 'http://api.test/_dunx' });
