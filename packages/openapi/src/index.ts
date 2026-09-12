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
  DocumentSource,
  generateDocument,
  type DocumentContributor,
  type DocumentFragment,
  type DocumentInfo,
  type GeneratedDocument,
} from './generate.js';
// The page, whichever renderer produces it. `renderShell` is the markup they have
// in common and `PackageAssets` resolves the files it links out of the consumer's
// own install, so a renderer of your own is those two plus a `DocsRenderer`.
// dunx ships `@dunx/openapi/swagger` and `@dunx/openapi/scalar`, each behind its
// own optional peer dependency.
export {
  DOCUMENT_ELEMENT_ID,
  readDocument,
  renderShell,
  type ShellParts,
} from './shell.js';
export { DocsRenderer, type PageOptions } from './renderer.js';
export {
  ASSET_CACHE_CONTROL,
  PackageAssets,
  type AssetPackage,
} from './assets.js';
export { OpenApiExplorer } from './explorer.js';
export {
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
  type OperationObject,
  type OperationKey,
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
