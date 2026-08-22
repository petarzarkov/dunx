import {
  markController,
  markRoute,
  type HttpMethod,
  type RoutePath,
} from './marker.js';
import type { Input, Returns, RouteSchemas } from './schema.js';

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
 * The `H` constraint is the guarantee, on both halves of the signature. A wrongly
 * annotated `input` is a `TS1241` + `TS1270` naming the mismatched property; an
 * unannotated one is `TS7006`. Inference is impossible here - see
 * docs/architecture/constraints.md, "A route decorator can *check* a handler's
 * input type but cannot *infer* it".
 *
 * `const M` is what makes the return half work: the verb has to reach the type
 * level as `'POST'` rather than as `HttpMethod` for `Returns` to know that an
 * options object with no `status` is documenting a 201.
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
