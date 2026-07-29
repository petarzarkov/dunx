import {
  isIdentifier,
  isPropertyDefinition,
  isTypeReference,
  isUnionType,
  type ClassNode,
  type Node,
  type PropertyDefinition,
} from './ast.js';

/**
 * A TC39 field decorator is handed a name and a context — never a type. That is
 * the same erasure that made constructor injection impossible before this
 * package existed, so the same answer applies: read the annotation from the
 * source and record it next to the class.
 *
 * Only **decorated** fields are recorded. A decorator is the declaration that
 * something wants metadata about this field; every other field would be pure
 * emitted weight.
 */
const FIELDS_KEY = "Symbol.for('dunx.fields')";

/**
 * The key the record is written under. A consumer looks it up with
 * `Symbol.for(FIELDS_SYMBOL_KEY)` rather than importing anything from here —
 * `@dunx/compiler` pulls a native parser, and no runtime package should take that
 * on to read one symbol. `@dunx/core` reads `dunx.deps` the same way.
 */
export const FIELDS_SYMBOL_KEY = 'dunx.fields';

/** A field whose annotation named something that survives to runtime. */
export interface FieldMeta {
  /** The annotation as written — `'string'`, `'number'`, `'Date'`, `'Uint8Array'`. */
  readonly type: string;
  /** The `?`. Absent rather than `false` so the emitted record stays small. */
  readonly optional?: true;
  /** Spelled `T | null`. */
  readonly nullable?: true;
}

/**
 * A field whose annotation is erased — an interface, a union that is not
 * `T | null`, a generic reference, a type-only import, a class type parameter, or
 * no annotation at all. `unresolved` is the declaration as written, so the
 * consumer can name the field *and* quote it back.
 */
export interface UnresolvedField {
  readonly unresolved: string;
}

export type FieldEntry = FieldMeta | UnresolvedField;

/** What the thunk under `Symbol.for('dunx.fields')` returns, keyed by field name. */
export type FieldRecord = Readonly<Record<string, FieldEntry>>;

export const isUnresolvedField = (
  entry: FieldEntry,
): entry is UnresolvedField => 'unresolved' in entry;

/** Keyword annotations, which have no value form to name. */
const KEYWORDS: Readonly<Record<string, string>> = Object.freeze({
  TSStringKeyword: 'string',
  TSNumberKeyword: 'number',
  TSBooleanKeyword: 'boolean',
  TSBigIntKeyword: 'bigint',
});

interface Resolved {
  readonly type: string;
  readonly nullable: boolean;
}

/**
 * A single annotation, ignoring nullability. `Date` and `Uint8Array` come back as
 * the written name — this records what the source says and leaves the meaning of
 * `Date` to whoever reads the record.
 */
const simpleType = (
  annotation: Node,
  erased: ReadonlySet<string>,
): string | undefined => {
  const keyword = KEYWORDS[annotation.type];
  if (keyword !== undefined) return keyword;

  if (!isTypeReference(annotation)) return undefined;
  // A qualified or generic name is not a scalar; only a bare identifier is.
  if (!isIdentifier(annotation.typeName)) return undefined;
  if (annotation.typeArguments) return undefined;

  const name = annotation.typeName.name;
  return erased.has(name) ? undefined : name;
};

/**
 * `T | null` is the one union that resolves. It is how a nullable column is
 * spelled, and reading it here is what keeps the declared type and the column
 * definition from being written twice. Every other union is erased as far as a
 * single column type goes, so it is refused rather than guessed at.
 */
const resolve = (
  annotation: Node | undefined,
  erased: ReadonlySet<string>,
): Resolved | undefined => {
  if (annotation === undefined) return undefined;

  if (isUnionType(annotation)) {
    const nulls = annotation.types.filter(
      (member) => member.type === 'TSNullKeyword',
    );
    const rest = annotation.types.filter(
      (member) => member.type !== 'TSNullKeyword',
    );
    const only = rest[0];
    if (nulls.length !== 1 || rest.length !== 1 || only === undefined) {
      return undefined;
    }
    const type = simpleType(only, erased);
    return type === undefined ? undefined : { type, nullable: true };
  }

  const type = simpleType(annotation, erased);
  return type === undefined ? undefined : { type, nullable: false };
};

/**
 * Decorated, named, instance fields. A static field belongs to the class rather
 * than a row, a computed key is not knowable at load time, and a `#private` one
 * is unreachable from outside — none of them can be described.
 */
const decoratedFields = (klass: ClassNode): readonly PropertyDefinition[] =>
  klass.body.body.filter(
    (member): member is PropertyDefinition =>
      isPropertyDefinition(member) &&
      member.decorators.length > 0 &&
      !member.static &&
      !member.computed &&
      isIdentifier(member.key),
  );

/** `name!: string | null` — the declaration without its decorators. */
const declarationOf = (source: string, field: PropertyDefinition): string =>
  source.slice(field.key.start, field.end).trim().replace(/;$/, '');

const entryFor = (
  source: string,
  field: PropertyDefinition,
  erased: ReadonlySet<string>,
): string => {
  const name = isIdentifier(field.key) ? field.key.name : '';
  const key = JSON.stringify(name);
  const resolved = resolve(field.typeAnnotation?.typeAnnotation, erased);

  if (resolved === undefined) {
    const text = JSON.stringify(declarationOf(source, field));
    return `${key}: { unresolved: ${text} }`;
  }

  const parts = [`type: ${JSON.stringify(resolved.type)}`];
  if (field.optional) parts.push('optional: true');
  if (resolved.nullable) parts.push('nullable: true');
  return `${key}: { ${parts.join(', ')} }`;
};

/**
 * The statement to append after the class, or `undefined` when it has no
 * decorated field. A thunk for the same reason the dependency record is one: it
 * is appended *after* the class declaration, which is after its decorators have
 * already run, so nothing may read it before the class is fully defined.
 */
export const fieldRecordFor = (
  source: string,
  klass: ClassNode,
  erased: ReadonlySet<string>,
): string | undefined => {
  const name = klass.id?.name;
  const fields = decoratedFields(klass);
  if (name === undefined || fields.length === 0) return undefined;

  const entries = fields.map((field) => entryFor(source, field, erased));
  return (
    `\nObject.defineProperty(${name}, ${FIELDS_KEY}, {\n` +
    `  value: () => ({ ${entries.join(', ')} }),\n});`
  );
};
