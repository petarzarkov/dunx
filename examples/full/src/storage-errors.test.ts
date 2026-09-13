import { expect, it } from 'bun:test';
import {
  FileNotFoundError,
  PathTraversalError,
  UnsupportedOperationError,
} from '@dunx/infra/files';

/**
 * Against the **built** package, which is the only place this can fail, and its
 * own file so `service.test.ts` stays under the 800-line cap. 3.8.1 shipped
 * `FileNotFoundError` as `FileNotFoundError2`, because `new.target.name` reads the
 * name the bundler emitted. Consumers match these by name.
 */
it('reports each storage error under its own exported name', () => {
  expect(new FileNotFoundError('missing.txt').name).toBe('FileNotFoundError');
  expect(new PathTraversalError('../x').name).toBe('PathTraversalError');
  expect(new UnsupportedOperationError('presign', 'LocalStorage').name).toBe(
    'UnsupportedOperationError',
  );
});
