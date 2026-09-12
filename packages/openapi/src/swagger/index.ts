// Swagger UI, mounted over a generated document. `swagger-ui-dist` is an optional
// peer dependency: importing this subpath is what asks for it.
export { SWAGGER_ASSETS, SwaggerRenderer } from './renderer.js';
export { MOUNT_ELEMENT_ID, renderSwaggerPage } from './html.js';
// Every Swagger UI parameter, typed. `RawJs` is the seam for the seven that are
// functions and therefore cannot cross from a server-rendered page as values.
export {
  DEFAULT_UI_OPTIONS,
  renderUiOptions,
  SYNTAX_THEMES,
  type DocExpansion,
  type ModelRendering,
  type RawJs,
  type SubmitMethod,
  type SwaggerUiOptions,
  type SyntaxHighlightOptions,
  type SyntaxTheme,
} from './options.js';
