import type { JsonSchema, OpenApiDocument } from './types.js';

export const COMPONENTS_PREFIX = '#/components/schemas/';

/** Where zod puts a named definition. Only the prefix differs from OpenAPI's. */
export const DEFS_PREFIX = '#/$defs/';

export const refTo = (name: string): JsonSchema => ({
  $ref: `${COMPONENTS_PREFIX}${name}`,
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Walks any JSON value and rewrites every `$ref` through `map`. Structural, not
 * schema-aware: a `$ref` is legal anywhere in a JSON Schema - inside `items`,
 * `properties`, `anyOf`, `patternProperties`, a `$def` of its own - so nothing here
 * knows which keywords those are.
 */
export const rewriteRefs = (
  value: unknown,
  map: (ref: string) => string,
): unknown => {
  if (Array.isArray(value))
    return value.map((entry) => rewriteRefs(entry, map));
  if (!isRecord(value)) return value;

  const rewritten: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    rewritten[key] =
      key === '$ref' && typeof entry === 'string'
        ? map(entry)
        : rewriteRefs(entry, map);
  }
  return rewritten;
};

export const collectRefs = (
  value: unknown,
  into = new Set<string>(),
): Set<string> => {
  if (Array.isArray(value)) {
    for (const entry of value) collectRefs(entry, into);
    return into;
  }
  if (!isRecord(value)) return into;

  for (const [key, entry] of Object.entries(value)) {
    if (key === '$ref' && typeof entry === 'string') into.add(entry);
    else collectRefs(entry, into);
  }
  return into;
};

/**
 * The components reachable from the rest of the document, following refs between
 * components too, so a definition used only by another definition survives.
 *
 * Needed because a schema can reach `components/schemas` without anything
 * referencing it: zod 4.5 emits any root carrying `.meta({ id })` into `$defs`,
 * and a `params` or `query` schema is expanded into `parameters` rather than
 * referenced, so a named one would leave an orphan behind. zod 4.4 inlined that
 * root and left nothing.
 */
export const reachableComponents = (
  document: unknown,
  schemas: Readonly<Record<string, unknown>>,
): Set<string> => {
  const nameOf = (ref: string): string | undefined =>
    ref.startsWith(COMPONENTS_PREFIX)
      ? ref.slice(COMPONENTS_PREFIX.length)
      : undefined;

  // Seeded from everything but `components`, so a component referencing itself
  // does not keep itself alive.
  const { components: _components, ...rest } = document as Record<
    string,
    unknown
  >;
  const reached = new Set<string>();
  const queue: string[] = [];

  for (const ref of collectRefs(rest)) {
    const name = nameOf(ref);
    if (name !== undefined && !reached.has(name)) {
      reached.add(name);
      queue.push(name);
    }
  }

  while (queue.length > 0) {
    const current = queue.pop() as string;
    for (const ref of collectRefs(schemas[current])) {
      const name = nameOf(ref);
      if (name !== undefined && !reached.has(name)) {
        reached.add(name);
        queue.push(name);
      }
    }
  }

  return reached;
};

/**
 * Every `$ref` in the document that does not land on a present
 * `components/schemas` entry. A dangling `$ref` is the usual way generated OpenAPI
 * is silently broken - a viewer renders an empty box and says nothing - so this is
 * asserted on rather than hoped for.
 */
export const danglingRefs = (document: OpenApiDocument): readonly string[] => {
  const present = new Set(Object.keys(document.components.schemas));
  const dangling = new Set<string>();

  for (const ref of collectRefs(document)) {
    if (!ref.startsWith(COMPONENTS_PREFIX)) {
      dangling.add(ref);
      continue;
    }
    if (!present.has(ref.slice(COMPONENTS_PREFIX.length))) dangling.add(ref);
  }

  return [...dangling].sort();
};

/**
 * `components/schemas` while it is being filled, plus the warnings collected on the
 * way. Nothing in this package throws over a schema it cannot convert - a document
 * missing one body is worth more than no document at all - so every degradation
 * lands here instead.
 */
/**
 * A component's own name as its `title`, unless it declared one - the only thing
 * an explorer can label a nested schema by. Swagger UI renders a model as
 * `schema.title || displayName || name`, and a schema reached through `items`
 * supplies neither, so `array<User>` rendered as `array<object>`.
 *
 * The title is the name, so the Schemas list reads as it did.
 */
export const titledAs = (name: string, schema: JsonSchema): JsonSchema =>
  schema['title'] === undefined ? { title: name, ...schema } : schema;

export class SchemaStore {
  readonly #schemas = new Map<string, JsonSchema>();
  readonly #warnings: string[] = [];

  get warnings(): readonly string[] {
    return this.#warnings;
  }

  warn(message: string): void {
    if (!this.#warnings.includes(message)) this.#warnings.push(message);
  }

  /**
   * Identical definitions collapse - the same zod object reached from two routes is
   * one component. Two *different* schemas claiming one name keeps the first and
   * warns: renaming would silently repoint refs a caller had already read.
   */
  add(name: string, schema: JsonSchema): string {
    const titled = titledAs(name, schema);
    const existing = this.#schemas.get(name);
    if (existing === undefined) {
      this.#schemas.set(name, titled);
      return name;
    }
    if (!Bun.deepEquals(existing, titled)) {
      this.warn(
        `Two different schemas are both named "${name}". The first one won. ` +
          'Give one of them a different .meta({ id }).',
      );
    }
    return name;
  }

  /**
   * A definition already hoisted, by name. `convertObject` needs it because zod
   * 4.5 emits a named root as a bare `$ref` into `$defs` rather than inline, and
   * parameters have to be expanded from the object itself.
   */
  get(name: string): JsonSchema | undefined {
    return this.#schemas.get(name);
  }

  snapshot(): Record<string, JsonSchema> {
    return Object.fromEntries(
      [...this.#schemas].sort(([a], [b]) => (a < b ? -1 : 1)),
    );
  }
}
