import {
  meta,
  metaKey,
  PUBLIC,
  ROLES,
  type MetaKey,
  type MetaRecord,
} from '@dunx/http';

/** What `@ApiDoc` adds that no schema can carry: prose, grouping, deprecation. */
export interface ApiDocMeta {
  readonly summary?: string;
  readonly description?: string;
  /** Overrides the tag derived from the controller's name. */
  readonly tags?: readonly string[];
  readonly deprecated?: boolean;
}

/**
 * Route metadata is `@dunx/http`'s generic mechanism - `metaKey` mints a unique
 * symbol and `meta` writes it onto the method or the class. `@ApiDoc` is a wrapper
 * over it and nothing more, which is why documentation needs no parallel registry
 * and no second discovery pass.
 */
export const API_DOC: MetaKey<ApiDocMeta> = metaKey<ApiDocMeta>('openapi');

export const ApiDoc = (doc: ApiDocMeta) => meta(API_DOC, doc);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const stringOr = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined;

const stringsOf = (value: unknown): readonly string[] | undefined =>
  Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : undefined;

/**
 * A `MetaRecord` is `ReadonlyMap<symbol, unknown>` - whoever wrote the value chose
 * its shape, so it is checked here rather than asserted.
 */
export const apiDocOf = (record: MetaRecord | undefined): ApiDocMeta => {
  const value = record?.get(API_DOC.id);
  if (!isRecord(value)) return {};

  const summary = stringOr(value['summary']);
  const description = stringOr(value['description']);
  const tags = stringsOf(value['tags']);
  const deprecated = value['deprecated'];

  return {
    ...(summary !== undefined ? { summary } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(tags !== undefined && tags.length > 0 ? { tags } : {}),
    ...(deprecated === true ? { deprecated: true } : {}),
  };
};

/** What `@Roles('admin')` declared, class-level or method-level - merged already. */
export const rolesOf = (
  record: MetaRecord | undefined,
): readonly string[] | undefined => {
  const roles = stringsOf(record?.get(ROLES.id));
  return roles !== undefined && roles.length > 0 ? roles : undefined;
};

export const isPublic = (record: MetaRecord | undefined): boolean =>
  record?.get(PUBLIC.id) === true;
