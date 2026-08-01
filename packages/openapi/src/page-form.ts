import { sampleFor } from './sample.js';
import type {
  JsonSchema,
  OperationKey,
  OperationObject,
  ParameterObject,
} from './types.js';

const escape = (value: string): string => Bun.escapeHTML(value);

/** A scalar sample makes a useful placeholder; an object or array does not. */
const placeholderFor = (schema: JsonSchema): string => {
  const value = sampleFor(schema, {});
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return '';
};

const field = (parameter: ParameterObject): string => {
  const id = `${parameter.in}-${parameter.name}`;
  const required = parameter.required === true;
  return (
    `<label><span>${escape(parameter.name)}` +
    `<em>${escape(parameter.in)}${required ? ' · required' : ''}</em></span>` +
    `<input name="${escape(id)}" data-in="${escape(parameter.in)}" ` +
    `data-name="${escape(parameter.name)}" ` +
    `placeholder="${escape(placeholderFor(parameter.schema))}"` +
    `${required ? ' required' : ''}></label>`
  );
};

/**
 * Every `{name}` in the path gets an input, declared or not.
 *
 * A document is free to leave a path parameter out of `parameters` — it is bad
 * practice but it is valid — and without this the template would be sent with a
 * literal `{id}` in it. Declared parameters win, so their schema and
 * requiredness are kept; the rest are synthesised as required strings.
 */
const fieldsFor = (
  path: string,
  declared: readonly ParameterObject[],
): readonly ParameterObject[] => {
  const named = new Set(
    declared.filter((p) => p.in === 'path').map((p) => p.name),
  );
  const missing = [...path.matchAll(/\{([^}]+)\}/g)]
    .map((match) => match[1] ?? '')
    .filter((name) => name !== '' && !named.has(name))
    .map(
      (name): ParameterObject => ({
        name,
        in: 'path',
        required: true,
        schema: { type: 'string' },
      }),
    );
  return [...missing, ...declared];
};

const bodyBox = (
  operation: OperationObject,
  schemas: Readonly<Record<string, JsonSchema>>,
): string => {
  const content = operation.requestBody?.content['application/json'];
  if (content === undefined) return '';
  // Pre-filled from the schema, so sending is one click rather than a typing
  // exercise. It is a starting point, not a promise the server will accept it.
  const sample = JSON.stringify(sampleFor(content.schema, schemas), null, 2);
  return (
    '<label class="wide"><span>body<em>application/json</em></span>' +
    `<textarea data-body rows="8" spellcheck="false">${escape(sample)}</textarea></label>`
  );
};

/**
 * The form that makes an operation executable, and the box its response lands in.
 *
 * The page stays useful without it — this is markup plus one shared listener, not
 * a viewer. Path parameters are substituted into the template, query parameters
 * are appended when non-empty, and extra headers are one `Name: value` per line
 * so an `Authorization` header needs no special field.
 */
export const tryBlock = (
  path: string,
  method: OperationKey,
  operation: OperationObject,
  schemas: Readonly<Record<string, JsonSchema>>,
): string => {
  const fields = fieldsFor(path, operation.parameters ?? [])
    .map(field)
    .join('');
  const auth =
    operation.security !== undefined && operation.security.length > 0
      ? 'Authorization: Bearer '
      : '';

  return (
    '<div class="tryit"><h3>Send it</h3>' +
    `<form class="try" data-method="${escape(method)}" data-path="${escape(path)}">` +
    `<div class="grid">${fields}` +
    '<label class="wide"><span>headers<em>one per line</em></span>' +
    `<textarea data-headers rows="2" spellcheck="false" ` +
    `placeholder="Authorization: Bearer token">${escape(auth)}</textarea></label>` +
    bodyBox(operation, schemas) +
    '</div>' +
    `<button type="submit">${escape(method.toUpperCase())} ${escape(path)}</button>` +
    '</form>' +
    '<div class="out" hidden><p data-status></p>' +
    '<pre class="hdr"><code data-headers-out></code></pre>' +
    '<pre><code data-body-out></code></pre></div>' +
    '</div>'
  );
};
