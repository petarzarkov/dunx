import { createTheme, type MantineThemeOverride } from '@mantine/core';

/**
 * One Mantine theme for every dunx frontend.
 *
 * It was the documentation site's, declared inline in its entry, and the OpenAPI
 * explorer had **no** theme at all - so the two looked related rather than the same.
 * Sharing it is the point of this package: a reader who opens `/api/docs` in an app
 * and then the framework's own site should not be able to tell they were built
 * separately.
 *
 * Deliberately small. A theme is tokens - colour, radius, type - and anything a
 * single site needs on top belongs in that site, not here. `@dunx/openapi` inlines
 * the explorer bundle byte for byte into the page it serves, so every symbol this
 * package grows is paid for twice there.
 */
export const theme: MantineThemeOverride = createTheme({
  primaryColor: 'indigo',
  fontFamilyMonospace:
    'ui-monospace, SFMono-Regular, Menlo, "JetBrains Mono", monospace',
  defaultRadius: 'md',
});
