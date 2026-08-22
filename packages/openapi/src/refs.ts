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
 * A component's own name as its `title`, unless it declared one.
 *
 * That is the only thing an explorer can label a **nested** schema by. Swagger UI
 * 5.32.14 renders a model as `schema.title || displayName || name` - verified in
 * `swagger-ui-bundle.js`, in all three of its model components. A root `$ref`
 * supplies those two fallbacks from the ref itself, but a schema reached through
 * `items` supplies neither, so `array<User>` rendered as `array<object>` while the
 * same `User` at the root of a response rendered as `User`. `title` is the one field
 * that reaches both positions.
 *
 * This is not the sentence-in-`title` mistake that put prose in the Schemas list.
 * The title here **is** the name, identical to the key, so that list reads exactly
 * as it did; prose still belongs in `description`.
 *
 * Applied to a contributed schema too, so better-auth's `Session` labels the same
 * way a generated `User` does.
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

  snapshot(): Record<string, JsonSchema> {
    return Object.fromEntries(
      [...this.#schemas].sort(([a], [b]) => (a < b ? -1 : 1)),
    );
  }
}
