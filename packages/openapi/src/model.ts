import { sampleFor } from './sample.js';
import {
  OPERATION_ORDER,
  type OpenApiDocument,
  type OperationKey,
  type OperationObject,
  type ParameterLocation,
  type ParameterObject,
} from './types.js';

/** One input in an operation's send form, already resolved against the schema. */
export interface TryField {
  readonly name: string;
  readonly in: ParameterLocation;
  readonly required: boolean;
  /** A scalar `sampleFor` value, or `''` where the schema yields no useful one. */
  readonly placeholder: string;
}

/**
 * What the page hands its UI: the document verbatim, plus the three things only
 * the server can compute.
 *
 * `prose` is `Bun.markdown` output and `samples` is `sampleFor` output - both
 * native, both already covered by tests here, and neither worth a second
 * implementation in the browser bundle. Keeping them on this side is also what
 * stops a markdown parser from landing in the page.
 */
export interface PageModel {
  readonly document: OpenApiDocument;
  readonly jsonHref: string;
  readonly warnings: readonly string[];
  /** Keys: `info`, `tag:<name>`, `op:<operationId>`. Values are rendered HTML. */
  readonly prose: Readonly<Record<string, string>>;
  /** `operationId` -> the pre-filled JSON request body. */
  readonly samples: Readonly<Record<string, string>>;
  /** `operationId` -> its send-form inputs, path parameters synthesised. */
  readonly fields: Readonly<Record<string, readonly TryField[]>>;
}

/**
 * Author-written prose. Bun parses the markdown; nothing here reimplements it.
 * Raw HTML is turned off in the parser rather than trusted - a description
 * reaching this page came from a schema, and a schema can come from anywhere.
 */
const prose = (markdown: string): string =>
  Bun.markdown.html(markdown, {
    noHtmlBlocks: true,
    noHtmlSpans: true,
    tagFilter: true,
  });

/** A scalar sample makes a useful placeholder; an object or array does not. */
const placeholderFor = (parameter: ParameterObject): string => {
  const value = sampleFor(parameter.schema, {});
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return '';
};

/**
 * Every `{name}` in the path gets an input, declared or not.
 *
 * A document is free to leave a path parameter out of `parameters` - it is bad
 * practice but it is valid - and without this the template would be sent with a
 * literal `{id}` in it. Declared parameters win, so their schema and
 * requiredness are kept; the rest are synthesised as required strings.
 */
export const fieldsFor = (
  path: string,
  declared: readonly ParameterObject[],
): readonly TryField[] => {
  const named = new Set(
    declared.filter((parameter) => parameter.in === 'path').map((p) => p.name),
  );
  const missing: readonly TryField[] = [...path.matchAll(/\{([^}]+)\}/g)]
    .map((match) => match[1] ?? '')
    .filter((name) => name !== '' && !named.has(name))
    .map((name) => ({
      name,
      in: 'path' as const,
      required: true,
      placeholder: 'string',
    }));

  return [
    ...missing,
    ...declared.map((parameter) => ({
      name: parameter.name,
      in: parameter.in,
      required: parameter.required === true,
      placeholder: placeholderFor(parameter),
    })),
  ];
};

const eachOperation = function* (
  document: OpenApiDocument,
): Generator<readonly [string, OperationKey, OperationObject]> {
  for (const [path, item] of Object.entries(document.paths)) {
    for (const method of OPERATION_ORDER) {
      const operation = item[method];
      if (operation !== undefined) yield [path, method, operation];
    }
  }
};

export interface ModelOptions {
  readonly jsonHref: string;
  readonly warnings: readonly string[];
}

export const buildModel = (
  document: OpenApiDocument,
  options: ModelOptions,
): PageModel => {
  const proseMap: Record<string, string> = {};
  const samples: Record<string, string> = {};
  const fields: Record<string, readonly TryField[]> = {};

  if (document.info.description !== undefined) {
    proseMap['info'] = prose(document.info.description);
  }
  for (const tag of document.tags ?? []) {
    if (tag.description !== undefined) {
      proseMap[`tag:${tag.name}`] = prose(tag.description);
    }
  }

  for (const [path, , operation] of eachOperation(document)) {
    const id = operation.operationId;
    if (operation.description !== undefined) {
      proseMap[`op:${id}`] = prose(operation.description);
    }
    fields[id] = fieldsFor(path, operation.parameters ?? []);

    const json = operation.requestBody?.content['application/json'];
    if (json !== undefined) {
      // Pre-filled from the schema, so sending is one click rather than a
      // typing exercise. A starting point, not a promise the server accepts it.
      samples[id] = JSON.stringify(
        sampleFor(json.schema, document.components.schemas),
        null,
        2,
      );
    }
  }

  return {
    document,
    jsonHref: options.jsonHref,
    warnings: options.warnings,
    prose: proseMap,
    samples,
    fields,
  };
};
