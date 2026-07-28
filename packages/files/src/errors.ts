/**
 * Base for everything this package throws. `new.target.name` rather than a
 * hardcoded string, so every subclass reports its own name without repeating it.
 */
export class StorageError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
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
  }
}
