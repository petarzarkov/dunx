/**
 * The one `personSchema` shape, expressed in every validator the comparison
 * covers, all behind Standard Schema so `@dunx/http` cannot tell them apart.
 *
 * Loaded dynamically by id: a process that measures Valibot must not pay
 * ArkType's module-evaluation cost, which is large and lands in startup.
 */
import type { StandardSchemaIssue, StandardSchemaV1 } from '@dunx/http';
import type { Person } from '../shared.js';

export const validatorIds = [
  'noop',
  'noop-async',
  'zod',
  'valibot',
  'arktype',
  'typebox',
  'ajv',
] as const;

export type ValidatorId = (typeof validatorIds)[number];

const isValidatorId = (raw: string): raw is ValidatorId =>
  (validatorIds as readonly string[]).includes(raw);

export const validatorFromEnv = (): ValidatorId => {
  const raw = process.env['VALIDATOR'] ?? 'zod';
  if (!isValidatorId(raw)) {
    throw new Error(
      `Unknown VALIDATOR "${raw}". Known: ${validatorIds.join(', ')}`,
    );
  }
  return raw;
};

export type PersonSchema = StandardSchemaV1<unknown, Person>;

/**
 * TypeBox's compiler and ajv both expose a boolean predicate plus a separate error
 * iterator, and neither ships `~standard`. That is exactly the seam Standard Schema
 * exists for: eight lines here and `@dunx/http` treats a compiled JSON Schema
 * checker like any other validator.
 */
const bridge = (
  vendor: string,
  check: (value: unknown) => boolean,
  issuesOf: (value: unknown) => readonly StandardSchemaIssue[],
): PersonSchema => ({
  '~standard': {
    version: 1,
    vendor,
    validate: (value) =>
      check(value) ? { value: value as Person } : { issues: issuesOf(value) },
  },
});

/** `/name` and `/items/0` are JSON Pointers; Standard Schema wants segments. */
const pointerPath = (pointer: string): readonly string[] =>
  pointer === '' ? [] : pointer.slice(1).split('/');

/**
 * The two JSON Schema subjects get the same email check, because neither validates
 * `format` on its own and the point is to compare engines, not regexes. zod,
 * Valibot and ArkType each bring their own — noted in the README, since it is the
 * one place the schemas are not literally identical.
 */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const passthrough: PersonSchema = {
  '~standard': {
    version: 1,
    vendor: 'noop',
    validate: (value) => ({ value: value as Person }),
  },
};

/** The same no-op behind a resolved promise, which Standard Schema permits. */
const passthroughAsync: PersonSchema = {
  '~standard': {
    version: 1,
    vendor: 'noop-async',
    validate: async (value) => ({ value: value as Person }),
  },
};

const zodSchema = async (): Promise<PersonSchema> => {
  const { personSchema } = await import('../shared.js');
  return personSchema;
};

const valibotSchema = async (): Promise<PersonSchema> => {
  const v = await import('valibot');
  return v.object({
    name: v.pipe(v.string(), v.minLength(1)),
    age: v.pipe(v.number(), v.integer(), v.minValue(0)),
    email: v.pipe(v.string(), v.email()),
  });
};

const arktypeSchema = async (): Promise<PersonSchema> => {
  const { type } = await import('arktype');
  return type({
    name: 'string >= 1',
    age: 'number.integer >= 0',
    email: 'string.email',
  }) as PersonSchema;
};

const typeboxSchema = async (): Promise<PersonSchema> => {
  const { FormatRegistry, Type } = await import('@sinclair/typebox');
  const { TypeCompiler } = await import('@sinclair/typebox/compiler');
  // TypeBox validates `format` only against a registered checker, so an unregistered
  // "email" would silently pass anything and measure less work than the others.
  FormatRegistry.Set('email', (value) => EMAIL.test(value));
  const compiled = TypeCompiler.Compile(
    Type.Object({
      name: Type.String({ minLength: 1 }),
      age: Type.Integer({ minimum: 0 }),
      email: Type.String({ format: 'email' }),
    }),
  );

  return bridge(
    'typebox',
    (value) => compiled.Check(value),
    (value) =>
      [...compiled.Errors(value)].map((error) => ({
        message: error.message,
        path: pointerPath(error.path),
      })),
  );
};

const ajvSchema = async (): Promise<PersonSchema> => {
  const { Ajv } = await import('ajv');
  const ajv = new Ajv({ allErrors: true });
  // The same regex TypeBox is given above, rather than `ajv-formats`' RFC-shaped
  // one, so the two compiled subjects are doing the same amount of work.
  ajv.addFormat('email', EMAIL);
  const check = ajv.compile({
    type: 'object',
    properties: {
      name: { type: 'string', minLength: 1 },
      age: { type: 'integer', minimum: 0 },
      email: { type: 'string', format: 'email' },
    },
    required: ['name', 'age', 'email'],
  });

  return bridge(
    'ajv',
    (value) => check(value),
    (value) => {
      check(value);
      return (check.errors ?? []).map((error) => ({
        message: error.message ?? 'invalid',
        path: pointerPath(error.instancePath),
      }));
    },
  );
};

export const loadSchema = async (id: ValidatorId): Promise<PersonSchema> => {
  if (id === 'noop') return passthrough;
  if (id === 'noop-async') return passthroughAsync;
  if (id === 'zod') return zodSchema();
  if (id === 'valibot') return valibotSchema();
  if (id === 'arktype') return arktypeSchema();
  if (id === 'typebox') return typeboxSchema();
  return ajvSchema();
};
