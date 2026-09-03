import { markJobHandler, type JobMeta } from './marker.js';
import type { HandlerMethod } from '@dunx/core';

/**
 * Marks a method as the consumer of `name` on `queue`.
 *
 * There is no class decorator to go with it. A method's marker is the whole
 * record, and `WorkerFactory` finds it by walking the prototype chains of the
 * classes the modules already declare - so a handler needs no second
 * registration, and an abstract base's marked methods are inherited by every
 * subclass. See `packages/infra/README.md`, "queue", for a worked example.
 */
export const JobHandler =
  (meta: JobMeta) =>
  <T extends HandlerMethod>(value: T): T => {
    markJobHandler(value, meta);
    return value;
  };
