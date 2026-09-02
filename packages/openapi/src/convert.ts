import type { StandardSchemaV1 } from '@dunx/http';
import {
  COMPONENTS_PREFIX,
  DEFS_PREFIX,
  collectRefs,
  refTo,
  rewriteRefs,
  type SchemaStore,
} from './refs.js';
import type { JsonSchema } from './types.js';

/**
 * Standard Schema v1 has no JSON Schema export - it is a *validation* interface,
 * and deliberately nothing more. So conversion is per vendor, behind the vendor tag
 * the interface does carry, and zod is the vendor implemented here. Anything else
 * degrades to a permissive schema plus a warning: claiming to have documented a
 * body that was never read would be worse than saying so.
 */
type ZodModule = typeof import('zod');

/**
 * Which side of the wire a schema is describing. `input` is a request, `output` a
 * response: a field with a default is optional going in and always present coming
 * back, and `additionalProperties: false` is an output-side claim.
 */
export type SchemaDirection = 'input' | 'output';

interface ToJsonSchemaParams {
  readonly io: SchemaDirection;
  readonly unrepresentable: 'any';
}

/**
 * `toJSONSchema` takes a zod schema; what we hold is the Standard Schema view of
 * one. The vendor tag is the evidence that they are the same object, and this is
 * where that evidence is spent.
 */
interface ZodConverter {
  readonly toJSONSchema: (
    schema: object,
    params: ToJsonSchemaParams,
  ) => Record<string, unknown>;
}

let loading: Promise<ZodConverter | undefined> | undefined;

/**
 * zod is a `peerDependency`, so it is imported dynamically and only once a zod
 * schema has actually turned up. A consumer on Valibot never loads it, and one
 * without it installed gets warnings rather than a module-resolution crash at
 * import time.
 */
const loadZod = (): Promise<ZodConverter | undefined> => {
  loading ??= import('zod').then(
    (module: ZodModule) => module as unknown as ZodConverter,
    () => undefined,
  );
  return loading;
};

interface SchemaMeta {
  readonly id?: string;
  readonly title?: string;
  readonly description?: string;
}

interface MetaBearing {
  readonly meta?: () => SchemaMeta | undefined;
}

/** `.meta({ id })` is what names a definition. Read off the schema, not the output. */
export const metaOf = (schema: StandardSchemaV1): SchemaMeta | undefined => {
  const bearing = schema as StandardSchemaV1 & Partial<MetaBearing>;
  return typeof bearing.meta === 'function' ? bearing.meta() : undefined;
};

export const vendorOf = (schema: StandardSchemaV1): string =>
  schema['~standard'].vendor;

/**
 * Whether this is a Standard Schema at all, rather than a hand-written JSON Schema.
 *
 * `~standard` is the interface's own marker, so its absence is the discriminator -
 * and it is checked rather than assumed because `RouteSchemas.response` accepts
 * either. Everything that is parsed (`body`, `query`, `params`) still requires a
 * validator; only a documented response may be raw.
 */
export const isStandardSchema = (
  schema: StandardSchemaV1 | JsonSchema,
): schema is StandardSchemaV1 =>
  typeof schema === 'object' && schema !== null && '~standard' in schema;

/**
 * A JSON Schema is already the output format, so this only decides where it lands.
 *
 * `$id` hoists it into `components/schemas` under that name and leaves a `$ref`,
 * which is what `.meta({ id })` does for a zod schema - so one shape documented on
 * four routes is one definition rather than four copies. The key is stripped from
 * the hoisted body: it named the schema, it does not describe it.
 */
export const passThrough = (
  schema: JsonSchema,
  store: SchemaStore,
): Converted => {
  const { $id: id, ...rest } = schema;
  if (typeof id !== 'string' || id === '') return { schema };
  return { schema: refTo(store.add(id, rest)) };
};

const permissive = (vendor: string): JsonSchema => ({
  description:
    `Not documented: "${vendor}" schemas cannot be converted to JSON Schema, ` +
    'so anything is accepted here as far as this document is concerned.',
});

interface RootConversion {
  /** The root schema, inlined, with every `$ref` already pointing at components. */
  readonly root: JsonSchema | undefined;
  /** The name it must be registered under, from `.meta({ id })` or a self-ref. */
  readonly id?: string;
  /** It refs itself, so the name above has to exist whatever the caller does. */
  readonly selfReferential?: boolean;
  readonly unconverted?: string;
}

/**
 * zod 4.5's self-hoisted root, resolved to the definition it points at. Anything
 * else is returned untouched, including a root that carries siblings alongside a
 * `$ref`, which is not the shape this is for.
 */
const vendorRootKey = (
  root: Record<string, unknown>,
  defs: unknown,
): string | undefined => {
  const ref = root['$ref'];
  if (typeof ref !== 'string' || Object.keys(root).length !== 1) {
    return undefined;
  }
  if (!ref.startsWith(DEFS_PREFIX)) return undefined;
  if (typeof defs !== 'object' || defs === null) return undefined;
  const key = ref.slice(DEFS_PREFIX.length);
  const target = (defs as Record<string, unknown>)[key];
  return typeof target === 'object' && target !== null ? key : undefined;
};

/**
 * Converts, hoists `$defs` into `components/schemas`, and rewrites the refs that
 * pointed at them. zod emits `#/$defs/Tag`; OpenAPI wants
 * `#/components/schemas/Tag`. That is the whole difference - the definitions
 * themselves need no editing, which is why `.meta({ id })` is the only annotation
 * this package asks for.
 */
const convertRoot = async (
  schema: StandardSchemaV1,
  store: SchemaStore,
  fallbackName: string,
  io: SchemaDirection,
): Promise<RootConversion> => {
  const vendor = vendorOf(schema);
  if (vendor !== 'zod') {
    store.warn(
      `${fallbackName}: no JSON Schema conversion for Standard Schema vendor ` +
        `"${vendor}". Standard Schema validates; it does not describe. The schema ` +
        'is documented as permissive.',
    );
    return { root: undefined, unconverted: vendor };
  }

  const zod = await loadZod();
  if (!zod) {
    store.warn(
      `${fallbackName}: the schema is zod's, but zod could not be imported. ` +
        'It is a peerDependency of @dunx/openapi - install it to get real schemas.',
    );
    return { root: undefined, unconverted: vendor };
  }

  let emitted: Record<string, unknown>;
  try {
    // `io` is the direction: a *request* is the input side, where a field with a
    // default is optional and `additionalProperties: false` would be an
    // output-side claim, and a documented *response* is the output side.
    // `unrepresentable: 'any'` because a Date or a bigint in a schema must not
    // take the whole document down.
    emitted = zod.toJSONSchema(schema, { io, unrepresentable: 'any' });
  } catch (error) {
    store.warn(
      `${fallbackName}: zod refused to convert this schema - ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
    return { root: undefined, unconverted: vendor };
  }

  const { $schema: _schema, $defs: defs, ...vendorRoot } = emitted;
  // zod 4.5 hoists a schema carrying `.meta({ id })` into `$defs` and leaves a
  // bare `$ref` at the root, where 4.4 emitted it inline. Resolved back here so
  // everything downstream reads a schema rather than a reference: `convertObject`
  // splits the root into `parameters`, which a `$ref` cannot be, and `store.add`
  // deep-equals, so re-registering the resolved definition is idempotent rather
  // than a name collision with the one the `$defs` loop already stored.
  const selfHoisted = vendorRootKey(vendorRoot, defs);
  const rest =
    selfHoisted === undefined
      ? vendorRoot
      : ((defs as Record<string, unknown>)[selfHoisted] as Record<
          string,
          unknown
        >);
  // zod 4.4 spelled a self-reference `#`; 4.5 spells it `#/$defs/<name>`.
  const cyclic =
    selfHoisted !== undefined &&
    collectRefs(rest).has(`${DEFS_PREFIX}${selfHoisted}`);
  const id = metaOf(schema)?.id;
  // A cyclic schema refs the document root as `#`, which means "this schema" -
  // true where zod emitted it, false once it is one entry among many. Hoisting is
  // what gives it a place to point at, so a self-ref forces it.
  const name = id ?? fallbackName;
  const map = (ref: string): string => {
    if (ref.startsWith(DEFS_PREFIX)) {
      return `${COMPONENTS_PREFIX}${ref.slice(DEFS_PREFIX.length)}`;
    }
    return ref === '#' ? `${COMPONENTS_PREFIX}${name}` : ref;
  };

  if (defs !== undefined && typeof defs === 'object' && defs !== null) {
    for (const [key, definition] of Object.entries(defs)) {
      // The entry that *is* the root is the caller's to register or inline:
      // `convertSchema` hoists it, `convertObject` splits it into parameters and
      // wants it in neither. Storing it here left an unreferenced component in
      // the document for every named params schema.
      //
      // Unless it refers to itself. A cyclic root needs a component to point at,
      // which is the same reason `selfReferential` forces a hoist below.
      if (key === selfHoisted && !cyclic) continue;
      store.add(key, rewriteRefs(definition, map) as JsonSchema);
    }
  }

  const root = rewriteRefs(rest, map) as JsonSchema;
  const selfReferential = collectRefs(rest).has('#') || cyclic;
  return {
    root,
    ...(id !== undefined || selfReferential ? { id: name } : {}),
    ...(selfReferential ? { selfReferential } : {}),
  };
};

export interface Converted {
  /** A `$ref` when the schema was hoisted, the schema itself when it was inlined. */
  readonly schema: JsonSchema;
  /** Set when the vendor's schema could not be read at all. */
  readonly unconverted?: string;
}

/**
 * The definition a root `$ref` points at, when the root is nothing but that ref.
 * `undefined` for any other shape, including a ref the store does not hold.
 */
const resolved = (
  root: JsonSchema,
  store: SchemaStore,
): JsonSchema | undefined => {
  const ref = root['$ref'];
  if (typeof ref !== 'string' || !ref.startsWith(COMPONENTS_PREFIX)) {
    return undefined;
  }
  return store.get(ref.slice(COMPONENTS_PREFIX.length));
};

/**
 * The body case, and the response case with `io: 'output'`: a named schema becomes
 * a `components/schemas` entry and a `$ref`, an anonymous one is inlined where it
 * is used. One contract for both directions, so a response schema is hoisted
 * exactly as a request one is.
 */
export const convertSchema = async (
  schema: StandardSchemaV1,
  fallbackName: string,
  store: SchemaStore,
  io: SchemaDirection = 'input',
): Promise<Converted> => {
  const { root, id, unconverted } = await convertRoot(
    schema,
    store,
    fallbackName,
    io,
  );
  if (root === undefined) {
    return {
      schema: permissive(unconverted ?? vendorOf(schema)),
      ...(unconverted !== undefined ? { unconverted } : {}),
    };
  }
  if (id === undefined) return { schema: root };
  // zod 4.5 emits a named root as a bare `$ref` into `$defs`, which `convertRoot`
  // has already hoisted and repointed - so the ref is the answer. Adding it again
  // under the same name would register `Link` as a ref to itself and warn about
  // two schemas claiming one name. zod 4.4 inlined the object, and still does the
  // branch below.
  if (resolved(root, store) !== undefined) return { schema: root };
  return { schema: refTo(store.add(id, root)) };
};

export interface ObjectShape {
  readonly properties: Readonly<Record<string, JsonSchema>>;
  readonly required: readonly string[];
  readonly unconverted?: string;
}

/**
 * The parameter case. `?limit=10` is one parameter per property, so the root object
 * has to be read rather than referenced - a `$ref` cannot be split into
 * `parameters` entries.
 */
export const convertObject = async (
  schema: StandardSchemaV1,
  fallbackName: string,
  store: SchemaStore,
): Promise<ObjectShape> => {
  const { root, id, selfReferential, unconverted } = await convertRoot(
    schema,
    store,
    fallbackName,
    'input',
  );
  if (root === undefined) {
    return {
      properties: {},
      required: [],
      ...(unconverted !== undefined ? { unconverted } : {}),
    };
  }

  // Parameters are expanded, not referenced, so a named root normally needs no
  // component. A cyclic one does: its inner `#` was repointed at that name, and
  // nothing else would ever create it.
  if (selfReferential === true && id !== undefined) store.add(id, root);

  // zod 4.5 emits a named or cyclic root as a bare `$ref` into `$defs`, where 4.4
  // inlined the object and put `$ref: "#"` inside it. Both are valid and the peer
  // range is `^4`, so the ref is followed rather than either shape being assumed.
  // A `$ref` cannot be split into `parameters` entries.
  const object = resolved(root, store) ?? root;

  const properties = object['properties'];
  if (typeof properties !== 'object' || properties === null) {
    store.warn(
      `${fallbackName}: the schema is not an object, so it describes no ` +
        'named parameters. Use an object schema for params and query.',
    );
    return { properties: {}, required: [] };
  }

  const required = object['required'];
  return {
    properties: properties as Readonly<Record<string, JsonSchema>>,
    required: Array.isArray(required)
      ? required.filter((entry): entry is string => typeof entry === 'string')
      : [],
  };
};
