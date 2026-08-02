import { HttpStatusCode, type DiscoveredRoute } from '@dunx/http';
import { convertObject, convertSchema } from './convert.js';
import { apiDocOf, isPublic, rolesOf } from './metadata.js';
import { refTo, type SchemaStore } from './refs.js';
import type {
  JsonSchema,
  OperationObject,
  ParameterObject,
  ResponseObject,
  SecuritySchemeObject,
} from './types.js';

/** The scheme a `@Roles` route is documented against. */
export const SECURITY_SCHEME = 'bearer';

export const bearerScheme: SecuritySchemeObject = Object.freeze({
  type: 'http',
  scheme: 'bearer',
  description:
    'Whatever the guards in front of these routes accept. dunx does not ship an ' +
    'authentication scheme - this documents that a guard is there.',
});

/** `#/components/schemas/ValidationError`, registered on first use. */
export const VALIDATION_ERROR = 'ValidationError';

/**
 * The framework's own 400 body, from `defaultErrorMapper` and the flattening in
 * `buildInputReader`: `{ error, status, issues: [{ message, path }] }`. It is a real
 * response shape every schema-declaring route can produce, so it is documented
 * rather than left for a caller to discover from a failing request.
 */
const validationErrorSchema: JsonSchema = Object.freeze({
  type: 'object',
  title: 'Validation error',
  description:
    'A declared body, query or params schema rejected the request. Always a 400.',
  properties: {
    error: {
      type: 'string',
      description:
        'Which input was invalid: "Invalid body", "Invalid query", ...',
    },
    status: { type: 'integer', const: 400 },
    issues: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          message: { type: 'string' },
          path: {
            type: 'string',
            description:
              'Dotted path to the offending field, absent when the root failed.',
          },
        },
        required: ['message'],
      },
    },
  },
  required: ['error', 'status', 'issues'],
});

export const operationIdOf = (route: DiscoveredRoute): string =>
  `${route.controller}_${route.handlerName}`;

/** `UsersController` documents itself as `Users`. */
export const tagOf = (route: DiscoveredRoute): string => {
  const stripped = route.controller.replace(/Controller$/, '');
  return stripped === '' ? route.controller : stripped;
};

/** `/users/:id` is what Bun matches; `/users/{id}` is what OpenAPI templates. */
export const pathTemplate = (path: string): string =>
  path
    .split('/')
    .map((segment) =>
      segment.startsWith(':') ? `{${segment.slice(1)}}` : segment,
    )
    .join('/');

export const pathParams = (path: string): readonly string[] =>
  path
    .split('/')
    .filter((segment) => segment.startsWith(':'))
    .map((segment) => segment.slice(1));

/** The same rule `buildRoutes` applies: an explicit status, else 201 for POST. */
export const statusOf = (route: DiscoveredRoute): number =>
  route.options?.status ??
  (route.method === 'POST' ? HttpStatusCode.CREATED : HttpStatusCode.OK);

const statusText = (status: number): string => {
  const name = Object.entries(HttpStatusCode).find(
    ([, value]) => value === status,
  )?.[0];
  if (name === undefined) return 'Success';
  // `OK` is an initialism, not a word; every other name in the map reads as prose.
  if (!name.includes('_') && name.length <= 3) return name;
  const words = name.toLowerCase().replaceAll('_', ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
};

const withRoles = (
  description: string | undefined,
  roles: readonly string[],
): string => {
  const line = `Requires one of these roles: ${roles.map((role) => `\`${role}\``).join(', ')}.`;
  return description === undefined ? line : `${description}\n\n${line}`;
};

const parametersFor = async (
  route: DiscoveredRoute,
  operationId: string,
  store: SchemaStore,
): Promise<readonly ParameterObject[]> => {
  const parameters: ParameterObject[] = [];
  const tokens = pathParams(route.path);
  const declared = route.options?.params;
  const shape = declared
    ? await convertObject(declared, `${operationId}Params`, store)
    : undefined;

  // Driven by the path, not by the schema: OpenAPI requires every path parameter to
  // appear in the template, so a property that is not a token is not one.
  for (const name of tokens) {
    const schema = shape?.properties[name];
    parameters.push({
      name,
      in: 'path',
      required: true,
      schema: schema ?? { type: 'string' },
    });
  }

  const query = route.options?.query;
  if (query) {
    const shape = await convertObject(query, `${operationId}Query`, store);
    for (const [name, schema] of Object.entries(shape.properties)) {
      parameters.push({
        name,
        in: 'query',
        required: shape.required.includes(name),
        schema,
      });
    }
  }

  return parameters;
};

const responsesFor = (
  route: DiscoveredRoute,
  store: SchemaStore,
): Readonly<Record<string, ResponseObject>> => {
  const status = statusOf(route);
  const responses: Record<string, ResponseObject> = {
    [String(status)]: { description: statusText(status) },
  };

  const options = route.options;
  const validates =
    options?.body !== undefined ||
    options?.query !== undefined ||
    options?.params !== undefined;

  if (validates) {
    store.add(VALIDATION_ERROR, validationErrorSchema);
    responses['400'] = {
      description: 'A declared schema rejected the request',
      content: { 'application/json': { schema: refTo(VALIDATION_ERROR) } },
    };
  }

  return responses;
};

/**
 * One route to one operation. Everything read here is already on the route:
 * `options` are the schemas the request path validates against, and `meta` is what
 * `@Public`, `@Roles` and `@ApiDoc` wrote. Nothing is reconstructed from reflection.
 */
export const buildOperation = async (
  route: DiscoveredRoute,
  store: SchemaStore,
): Promise<OperationObject> => {
  const operationId = operationIdOf(route);
  const doc = apiDocOf(route.meta);
  const roles = rolesOf(route.meta);
  const parameters = await parametersFor(route, operationId, store);

  const body = route.options?.body;
  const converted = body
    ? await convertSchema(body, `${operationId}Body`, store)
    : undefined;

  const description = roles
    ? withRoles(doc.description, roles)
    : doc.description;

  return {
    operationId,
    tags: doc.tags ?? [tagOf(route)],
    ...(doc.summary !== undefined ? { summary: doc.summary } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(doc.deprecated === true ? { deprecated: true } : {}),
    ...(parameters.length > 0 ? { parameters } : {}),
    ...(converted
      ? {
          requestBody: {
            required: true,
            content: { 'application/json': { schema: converted.schema } },
          },
        }
      : {}),
    responses: responsesFor(route, store),
    // `@Public` is an explicit empty requirement, which overrides a document-level
    // default; a route that declared nothing inherits it instead.
    ...(isPublic(route.meta)
      ? { security: [] }
      : roles
        ? { security: [{ [SECURITY_SCHEME]: [] }], 'x-required-roles': roles }
        : {}),
    ...(converted?.unconverted !== undefined
      ? { 'x-schema-vendor': converted.unconverted }
      : {}),
  };
};
