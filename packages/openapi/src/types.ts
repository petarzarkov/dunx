/**
 * OpenAPI 3.1 restated as types, the same way `@dunx/http` restates Standard
 * Schema: the specification is a document shape, not a runtime, so depending on a
 * package for it would buy nothing. Only what this generator emits is declared -
 * a field missing here is a field dunx does not produce.
 */

/** A JSON Schema, as JSON. OpenAPI 3.1 embeds draft 2020-12 verbatim. */
export type JsonSchema = Readonly<Record<string, unknown>>;

export interface ServerObject {
  readonly url: string;
  readonly description?: string;
}

export type ParameterLocation = 'path' | 'query' | 'header' | 'cookie';

export interface ParameterObject {
  readonly name: string;
  readonly in: ParameterLocation;
  readonly required?: boolean;
  readonly description?: string;
  readonly schema: JsonSchema;
}

export interface MediaTypeObject {
  readonly schema: JsonSchema;
}

export interface RequestBodyObject {
  readonly required: boolean;
  readonly content: Readonly<Record<string, MediaTypeObject>>;
}

export interface ResponseObject {
  readonly description: string;
  readonly content?: Readonly<Record<string, MediaTypeObject>>;
}

/** Scheme name to scopes. An empty array is "authenticate, no scopes". */
export type SecurityRequirement = Readonly<Record<string, readonly string[]>>;

export interface OperationObject {
  readonly operationId: string;
  readonly tags?: readonly string[];
  readonly summary?: string;
  readonly description?: string;
  readonly deprecated?: boolean;
  readonly parameters?: readonly ParameterObject[];
  readonly requestBody?: RequestBodyObject;
  readonly responses: Readonly<Record<string, ResponseObject>>;
  /** Absent means "inherit the document default"; `[]` means "explicitly open". */
  readonly security?: readonly SecurityRequirement[];
  /** What `@Roles` declared. A scheme's scopes cannot carry it - roles are not scopes. */
  readonly 'x-required-roles'?: readonly string[];
  /** The Standard Schema vendor whose schema could not be converted. */
  readonly 'x-schema-vendor'?: string;
}

export type OperationKey = 'get' | 'post' | 'put' | 'patch' | 'delete';

export type PathItemObject = Partial<Record<OperationKey, OperationObject>>;

export interface SecuritySchemeObject {
  readonly type: 'http' | 'apiKey' | 'oauth2' | 'openIdConnect' | 'mutualTLS';
  readonly scheme?: string;
  readonly bearerFormat?: string;
  readonly description?: string;
  /** `apiKey` only: where the key travels. The page needs it to send one. */
  readonly in?: 'header' | 'query' | 'cookie';
  /** `apiKey` only: the header, query parameter or cookie name. */
  readonly name?: string;
}

export interface ComponentsObject {
  readonly schemas: Readonly<Record<string, JsonSchema>>;
  readonly securitySchemes?: Readonly<Record<string, SecuritySchemeObject>>;
}

export interface InfoObject {
  readonly title: string;
  readonly version: string;
  readonly description?: string;
}

export interface TagObject {
  readonly name: string;
  readonly description?: string;
}

export interface OpenApiDocument {
  readonly openapi: '3.1.0';
  readonly info: InfoObject;
  readonly servers?: readonly ServerObject[];
  readonly tags?: readonly TagObject[];
  readonly paths: Readonly<Record<string, PathItemObject>>;
  readonly components: ComponentsObject;
}

export const OPERATION_ORDER: readonly OperationKey[] = Object.freeze([
  'get',
  'post',
  'put',
  'patch',
  'delete',
]);
