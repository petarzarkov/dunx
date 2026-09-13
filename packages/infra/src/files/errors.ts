/**
 * Base for everything this package throws.
 *
 * Every class here writes its own `name` as a literal. It used to be
 * `new.target.name`, which reads the *emitted* class name, and the bundler renames
 * one whose name collides in a shared chunk: 3.8.1 shipped `FileNotFoundError` as
 * `FileNotFoundError2`. `instanceof` is false across two subpaths of this package,
 * so `error.name` is what a call site matches on. Only a test against the built
 * package catches it; that one is in `examples/full`.
 */
export class StorageError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'StorageError';
  }
}

/**
 * A backend-neutral ENOENT. Both backends map their own missing-object failure
 * onto this, so a call site does not have to know whether it is talking to a
 * disk or to a bucket.
 */
export class FileNotFoundError extends StorageError {
  constructor(
    readonly key: string,
    options?: ErrorOptions,
  ) {
    super(`No such file or object: "${key}".`, options);
    this.name = 'FileNotFoundError';
  }
}

export class PathTraversalError extends StorageError {
  constructor(
    readonly key: string,
    readonly root?: string,
  ) {
    super(
      `Refusing "${key}": it escapes the storage root` +
        (root === undefined ? '.' : ` "${root}".`),
    );
    this.name = 'PathTraversalError';
  }
}

export class UnsupportedOperationError extends StorageError {
  constructor(
    readonly operation: string,
    backend: string,
    hint?: string,
  ) {
    super(
      `${backend} does not support ${operation}().` +
        (hint === undefined ? '' : ` ${hint}`),
    );
    this.name = 'UnsupportedOperationError';
  }
}
