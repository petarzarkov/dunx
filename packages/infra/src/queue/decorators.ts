import { markJobHandler, type JobMeta } from './marker.js';

// never[] is what makes an arbitrary method signature assignable, so a handler may
// declare the `Job<T>` payload type it expects rather than the widest one.
type HandlerMethod = (...args: never[]) => unknown;

/**
 * Marks a method as the consumer of `name` on `queue`.
 *
 * There is no class decorator to go with it. A method's marker is the whole
 * record, and `WorkerFactory` finds it by walking the prototype chains of the
 * classes the modules already declare — so a handler needs no second
 * registration, and an abstract base's marked methods are inherited by every
 * subclass. See `packages/infra/README.md`, "queue", for a worked example.
 */
export const JobHandler =
  (meta: JobMeta) =>
  <T extends HandlerMethod>(value: T): T => {
    markJobHandler(value, meta);
    return value;
  };
