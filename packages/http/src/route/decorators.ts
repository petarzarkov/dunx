import {
  markController,
  markRoute,
  type ControllerOptions,
  type HttpMethod,
  type RoutePath,
} from './marker.js';
import type { Input, Returns, RouteSchemas } from './schema.js';

/**
 * `options.version` versions every handler; see `VersioningOptions`.
 *
 * `N` is every name `include` and `exclude` list, and the target has to have a
 * member of each, so a misspelt handler is a compile error. Discovery checks the
 * rest: that each one is a route and not some other method.
 */
export const Controller =
  <const N extends string = never>(
    prefix = '',
    options?: ControllerOptions<N>,
  ) =>
  <T extends abstract new (...args: never[]) => Record<N, unknown>>(
    target: T,
  ): T => {
    markController(target, prefix, options);
    return target;
  };

/**
 * `const O` is required: without it `{ body: CreateNote, status: 201 }` widens to
 * `RouteSchemas` and `Input<typeof opts>` degrades to bare `{ req }`.
 *
 * The `H` constraint carries the check on both halves. A wrongly annotated `input`
 * is a `TS1241`; an unannotated one is `TS7006`. Inference is impossible - see
 * docs/architecture/constraints.md.
 *
 * `const M` puts the verb at the type level as `'POST'`, so `Returns` knows an
 * options object with no `status` documents a 201.
 */
const verb =
  <const M extends HttpMethod>(method: M) =>
  <const O extends RouteSchemas>(path: RoutePath = '/', options?: O) =>
  <H extends (input: Input<O>) => Returns<O, M>>(
    value: H,
    _context: ClassMethodDecoratorContext,
  ): H => {
    markRoute(value, { method, path, options });
    return value;
  };

export const Get = verb('GET');
export const Post = verb('POST');
export const Put = verb('PUT');
export const Patch = verb('PATCH');
export const Delete = verb('DELETE');
