import type {
  OpenApiDocument,
  OperationKey,
  OperationObject,
} from './types.js';

/**
 * What every generator suite needs to read one operation out of a document, and
 * the `info` they all pass in.
 *
 * Four suites had written the same reader, and three of them had written the same
 * error messages with it. The messages are the reason it is worth sharing: a
 * missing path lists the paths the document does have, which is what turns an
 * assertion failure into a diagnosis.
 */
export const info = { title: 'Test API', version: '2.1.0' } as const;

export const operationOf = (
  document: OpenApiDocument,
  path: string,
  method: OperationKey,
): OperationObject => {
  const item = document.paths[path];
  if (item === undefined) {
    throw new Error(
      `no path ${path}; document has ${Object.keys(document.paths).join(', ')}`,
    );
  }
  const operation = item[method];
  if (operation === undefined) throw new Error(`no ${method} on ${path}`);
  return operation;
};
