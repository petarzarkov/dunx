// The conversion half. `convertSchema` is the vendor check itself - zod goes through
// `z.toJSONSchema`, anything else degrades to a permissive schema and a warning.
export {
  convertObject,
  convertSchema,
  metaOf,
  vendorOf,
  type Converted,
  type ObjectShape,
  type SchemaDirection,
} from './convert.js';
// Route metadata, on `@dunx/http`'s generic mechanism. `@ApiDoc` writes it; the
// readers are exported so a generator of your own can use the same channel.
export {
  ApiDoc,
  API_DOC,
  apiDocFor,
  apiDocOf,
  isPublic,
  rolesOf,
  type ApiDocMeta,
} from './metadata.js';
export { describeRoutes } from './discover.js';
export {
  generateDocument,
  type DocumentInfo,
  type GeneratedDocument,
} from './generate.js';
// The page shell, which is a Swagger UI boot script and nothing else. `renderShell`
// is exported so a page of your own can reuse the document embedding and the asset
// hrefs; `SwaggerAssets` is what resolves the consumer's `swagger-ui-dist`.
export {
  DOCUMENT_ELEMENT_ID,
  MOUNT_ELEMENT_ID,
  renderShell,
  type PageOptions,
} from './html.js';
export {
  ASSET_CACHE_CONTROL,
  contentTypeOf,
  isSwaggerAsset,
  SwaggerAssets,
  type SwaggerAsset,
} from './swagger.js';
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
} from './ui-options.js';
export {
  OpenApiExplorer,
  OpenApiModule,
  type OpenApiAsyncOptions,
  type OpenApiInfo,
  type OpenApiOptions,
} from './module.js';
export { mountPrefix, withPrefix } from './mount.js';
export {
  bearerScheme,
  buildOperation,
  operationIdOf,
  pathParams,
  pathTemplate,
  SECURITY_SCHEME,
  statusOf,
  tagOf,
  VALIDATION_ERROR,
} from './operations.js';
// `danglingRefs` is the check worth running on any generated document: a `$ref` that
// resolves to nothing renders as an empty box and reports nothing.
export {
  collectRefs,
  COMPONENTS_PREFIX,
  danglingRefs,
  DEFS_PREFIX,
  refTo,
  rewriteRefs,
  SchemaStore,
} from './refs.js';
export {
  OPERATION_ORDER,
  type ComponentsObject,
  type InfoObject,
  type JsonSchema,
  type MediaTypeObject,
  type OpenApiDocument,
  type OperationKey,
  type OperationObject,
  type ParameterLocation,
  type ParameterObject,
  type PathItemObject,
  type RequestBodyObject,
  type ResponseObject,
  type SecurityRequirement,
  type SecuritySchemeObject,
  type ServerObject,
  type TagObject,
} from './types.js';
