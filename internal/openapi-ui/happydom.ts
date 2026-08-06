import { GlobalRegistrator } from '@happy-dom/global-registrator';

/**
 * The explorer is a browser bundle, so its tests need a DOM before any module
 * under `src/` can load.
 *
 * Deliberately not routed through `@dunx/ui`: it is one line, the URL differs per
 * site, and a shared module that also imported Testing Library pulled that in
 * *before* the registrator ran - Testing Library captures `document` at import
 * time, so every suite then failed with "a global document has to be available".
 * The ordering is the whole constraint here, and it is cheapest to keep local.
 */
GlobalRegistrator.register({ url: 'http://api.test/docs' });
