export {
  FileNotFoundError,
  PathTraversalError,
  StorageError,
  UnsupportedOperationError,
} from './errors.js';
export { LocalStorage, LocalStorageOptions } from './local.js';
export { FilesModule } from './module.js';
export { S3Storage, S3StorageOptions } from './s3.js';
// Storage is the token to inject; StorageOptions is the token that chose it.
// Both are abstract classes, which is what makes them nameable as constructor
// parameter types — see @dunx/transform.
export {
  Storage,
  StorageOptions,
  type FileStat,
  type ListEntry,
  type ListOptions,
  type PresignOptions,
  type WriteData,
} from './storage.js';
