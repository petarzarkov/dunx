// Scalar, mounted over a generated document. `@scalar/api-reference` is an
// optional peer dependency: importing this subpath is what asks for it.
export { SCALAR_ASSETS, ScalarRenderer } from './renderer.js';
export { MOUNT_ELEMENT_ID, renderScalarPage } from './html.js';
export {
  DEFAULT_SCALAR_OPTIONS,
  renderScalarOptions,
  SCALAR_THEMES,
  type ScalarLayout,
  type ScalarOptions,
  type ScalarTheme,
} from './options.js';
