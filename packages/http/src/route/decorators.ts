import {
  markController,
  markRoute,
  type HttpMethod,
  type RoutePath,
} from './marker.js';
import type { Input, RouteSchemas } from './schema.js';

type ControllerTarget = abstract new (...args: never[]) => object;

export const Controller =
  (prefix = '') =>
  <T extends ControllerTarget>(target: T): T => {
    markController(target, prefix);
    return target;
  };

/**
 * `const O` is load-bearing: without it `{ body: CreateNote, status: 201 }` widens
 * to `RouteSchemas` and `Input<typeof opts>` degrades to bare `{ req }`, taking the
 * type check with it.
 *
 * The `M` constraint is the guarantee. A wrongly annotated `input` is a
 * `TS1241` + `TS1270` naming the mismatched property; an unannotated one is
 * `TS7006`. Inference is impossible here - see docs/ARCHITECTURE.md, "A route
 * decorator can *check* a handler's input type but cannot *infer* it".
 */
const verb =
  (method: HttpMethod) =>
  <const O extends RouteSchemas>(path: RoutePath = '/', options?: O) =>
  <M extends (input: Input<O>) => unknown>(
    value: M,
    _context: ClassMethodDecoratorContext,
  ): M => {
    markRoute(value, { method, path, options });
    return value;
  };

export const Get = verb('GET');
export const Post = verb('POST');
export const Put = verb('PUT');
export const Patch = verb('PATCH');
export const Delete = verb('DELETE');
