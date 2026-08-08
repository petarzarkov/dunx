import type { Meta } from '../../../packages/dashboard/src/api/types';

/**
 * Types come from `packages/dashboard/src` by relative import, so the wire format
 * has one declaration and this bundle cannot drift from the handler that fills it.
 * Same arrangement `internal/openapi-ui` has with `@dunx/openapi`, and it means
 * there is no build-order dependency between the two workspaces.
 */
export type { Meta };

/** Shared with `packages/dashboard/src/html.ts`. */
export const META_ELEMENT_ID = 'dunx-dashboard-meta';

export const readMeta = (doc: Document): Meta | undefined => {
  const element = doc.getElementById(META_ELEMENT_ID);
  if (element === null) return undefined;
  try {
    return JSON.parse(element.textContent ?? '') as Meta;
  } catch {
    return undefined;
  }
};
