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

interface ToJsonSchemaParams {
  readonly io: 'input' | 'output';
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
    // `io: 'input'` is what a *request* looks like: a field with a default is
    // optional going in and present coming out, and `additionalProperties: false`
    // is an output-side claim. `unrepresentable: 'any'` because a Date or a bigint
    // in a schema must not take the whole document down.
    emitted = zod.toJSONSchema(schema, {
      io: 'input',
      unrepresentable: 'any',
    });
  } catch (error) {
    store.warn(
      `${fallbackName}: zod refused to convert this schema - ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
    return { root: undefined, unconverted: vendor };
  }

  const { $schema: _schema, $defs: defs, ...rest } = emitted;
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
      store.add(key, rewriteRefs(definition, map) as JsonSchema);
    }
  }

  const root = rewriteRefs(rest, map) as JsonSchema;
  const selfReferential = collectRefs(rest).has('#');
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
 * The body case: a named schema becomes a `components/schemas` entry and a `$ref`,
 * an anonymous one is inlined where it is used.
 */
export const convertSchema = async (
  schema: StandardSchemaV1,
  fallbackName: string,
  store: SchemaStore,
): Promise<Converted> => {
  const { root, id, unconverted } = await convertRoot(
    schema,
    store,
    fallbackName,
  );
  if (root === undefined) {
    return {
      schema: permissive(unconverted ?? vendorOf(schema)),
      ...(unconverted !== undefined ? { unconverted } : {}),
    };
  }
  if (id === undefined) return { schema: root };
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

  const properties = root['properties'];
  if (typeof properties !== 'object' || properties === null) {
    store.warn(
      `${fallbackName}: the schema is not an object, so it describes no ` +
        'named parameters. Use an object schema for params and query.',
    );
    return { properties: {}, required: [] };
  }

  const required = root['required'];
  return {
    properties: properties as Readonly<Record<string, JsonSchema>>,
    required: Array.isArray(required)
      ? required.filter((entry): entry is string => typeof entry === 'string')
      : [],
  };
};
