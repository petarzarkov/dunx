import { markController, markRoute, type HttpMethod } from './marker.js';

type ControllerTarget = abstract new (...args: never[]) => object;
type RouteHandlerMethod = (...args: never[]) => unknown;

export const Controller =
  (prefix = '') =>
  <T extends ControllerTarget>(target: T): T => {
    markController(target, prefix);
    return target;
  };

const verb =
  (method: HttpMethod) =>
  (path = '/') =>
  <T extends RouteHandlerMethod>(value: T): T => {
    markRoute(value, { method, path });
    return value;
  };

export const Get = verb('GET');
export const Post = verb('POST');
export const Put = verb('PUT');
export const Patch = verb('PATCH');
export const Delete = verb('DELETE');
