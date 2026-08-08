import type { PageModel, TryField } from '../../../packages/openapi/src/model';
import {
  OPERATION_ORDER,
  type JsonSchema,
  type OpenApiDocument,
  type OperationKey,
  type OperationObject,
  type SecuritySchemeObject,
} from '../../../packages/openapi/src/types';

/**
 * The page model is written by `@dunx/openapi`, so its types come from that
 * package's source rather than a second declaration that could drift.
 *
 * `OPERATION_ORDER` is the one value among them, and it is imported for the same
 * reason: this file used to declare its own identical `METHODS` array. It is five
 * frozen strings in a module that is otherwise types, so nothing of the backend
 * reaches the bundle either way.
 */
export type {
  JsonSchema,
  OpenApiDocument,
  OperationKey,
  OperationObject,
  PageModel,
  SecuritySchemeObject,
  TryField,
};

export interface Entry {
  readonly path: string;
  readonly method: OperationKey;
  readonly operation: OperationObject;
  readonly tag: string;
}

export const entriesOf = (document: OpenApiDocument): readonly Entry[] => {
  const out: Entry[] = [];
  for (const [path, item] of Object.entries(document.paths)) {
    for (const method of OPERATION_ORDER) {
      const operation = item[method];
      if (operation === undefined) continue;
      for (const tag of operation.tags ?? ['default']) {
        out.push({ path, method, operation, tag });
      }
    }
  }
  return out;
};

export const groupByTag = (
  entries: readonly Entry[],
): readonly (readonly [string, readonly Entry[]])[] => {
  const grouped = new Map<string, Entry[]>();
  for (const entry of entries) {
    const list = grouped.get(entry.tag) ?? [];
    list.push(entry);
    grouped.set(entry.tag, list);
  }
  return [...grouped.entries()].sort((a, b) => a[0].localeCompare(b[0]));
};

export const matches = (entry: Entry, query: string): boolean => {
  if (query === '') return true;
  const needle = query.toLowerCase();
  return [
    entry.path,
    entry.method,
    entry.tag,
    entry.operation.operationId,
    entry.operation.summary ?? '',
  ].some((field) => field.toLowerCase().includes(needle));
};

export const COMPONENTS_PREFIX = '#/components/schemas/';

/** `#/components/schemas/Tag` -> `Tag`, and only for a schema that is just a ref. */
export const refName = (schema: JsonSchema): string | undefined => {
  const ref = schema['$ref'];
  return typeof ref === 'string' && ref.startsWith(COMPONENTS_PREFIX)
    ? ref.slice(COMPONENTS_PREFIX.length)
    : undefined;
};

export const schemeNames = (operation: OperationObject): readonly string[] => [
  ...new Set((operation.security ?? []).flatMap((one) => Object.keys(one))),
];

/** `undefined` means "inherit"; `[]` means the route declared itself public. */
export const isPublic = (operation: OperationObject): boolean =>
  operation.security !== undefined && operation.security.length === 0;

const MODEL_ELEMENT_ID = 'dunx-openapi-model';

/**
 * The model travels in a `<script type="application/json">` the server wrote, so
 * the bundle parses one element and fetches nothing to start up.
 */
export const readModel = (doc: Document): PageModel | undefined => {
  const node = doc.getElementById(MODEL_ELEMENT_ID);
  if (node === null || node.textContent === null) return undefined;
  return JSON.parse(node.textContent) as PageModel;
};
