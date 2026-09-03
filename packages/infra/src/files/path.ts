import { resolve, sep } from 'node:path';
import { FileNotFoundError, PathTraversalError } from './errors.js';

/**
 * Both separators, so a `..\\..` key cannot walk past a check that only knows
 * about `/`. `node:path` is string maths only - nothing here touches the disk.
 */
const hasParentSegment = (key: string): boolean =>
  key.split(/[/\\]/).includes('..');

const isInside = (root: string, path: string): boolean =>
  path === root || path.startsWith(root + sep);

/**
 * Two checks, not one. The segment check runs first so a key is accepted or
 * refused identically on every platform: `..\\..\\etc` is a single legal
 * filename to POSIX `resolve` but three segments to Windows, and a key that
 * escapes on one OS must not quietly become a file on the other. The boundary
 * check then catches what segments cannot - an absolute key, or a root-relative
 * one that resolves out.
 */
const checkWithin = (root: string, key: string, allowRoot: boolean): string => {
  if (hasParentSegment(key)) throw new PathTraversalError(key, root);
  const path = resolve(root, key);
  if (!isInside(root, path) || (!allowRoot && path === root)) {
    throw new PathTraversalError(key, root);
  }
  return path;
};

/**
 * Absolute on-disk path for `key`, guaranteed to sit strictly inside `root`.
 * Rejects `../`, an absolute key, and the root itself - none of which name a
 * file the caller is entitled to.
 *
 * `resolve` collapses segments textually. A symlink inside the root that points
 * outside it is therefore still followed; resolving that needs `realpath`, which
 * cannot answer for a file that does not exist yet.
 */
export const resolveWithin = (root: string, key: string): string =>
  checkWithin(root, key, false);

/** Same checks, but the root itself is a legitimate directory to scan. */
export const resolveDirWithin = (root: string, prefix: string): string =>
  checkWithin(root, prefix, true);

/**
 * An object key with leading slashes and duplicate separators removed. `..` is
 * rejected outright rather than collapsed: an S3 key is opaque, so a caller who
 * wrote `..` meant a path, and under a configured prefix that would escape it.
 */
export const normalizeKey = (key: string): string => {
  const normalized = key.replace(/\/{2,}/g, '/').replace(/^\/+/, '');
  if (normalized === '' || hasParentSegment(normalized)) {
    throw new PathTraversalError(key);
  }
  return normalized;
};

/** `''` or a key ending in exactly one `/`, ready to concatenate. */
export const normalizePrefix = (prefix: string): string => {
  if (prefix === '') return '';
  const normalized = normalizeKey(prefix);
  return normalized.endsWith('/') ? normalized : `${normalized}/`;
};

/** Filesystem-relative path to storage key. A no-op everywhere but Windows. */
export const toPosix = (path: string): string =>
  sep === '/' ? path : path.split(sep).join('/');

export const isMissing = (error: unknown): boolean => {
  if (typeof error !== 'object' || error === null) return false;
  const code = 'code' in error ? error.code : undefined;
  return code === 'ENOENT' || code === 'NoSuchKey';
};

/**
 * Runs `read`, turning a backend's own "not found" into `FileNotFoundError`.
 * Both storage backends need it and neither can inherit it: `#private` members
 * are unreachable from a subclass.
 */
export const guardMissing = async <T>(
  key: string,
  read: () => Promise<T>,
): Promise<T> => {
  try {
    return await read();
  } catch (error) {
    if (isMissing(error)) throw new FileNotFoundError(key, { cause: error });
    throw error;
  }
};
