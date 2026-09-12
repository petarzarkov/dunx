import type { PackageAssets } from '../assets.js';
import type { PageOptions } from '../renderer.js';
import { readDocument, renderShell } from '../shell.js';
import type { OpenApiDocument } from '../types.js';
import { renderScalarOptions, type ScalarOptions } from './options.js';

/** The element Scalar mounts into. */
export const MOUNT_ELEMENT_ID = 'scalar-api-reference';

/**
 * `data:,` paints no icon and costs no request. Scalar ships no favicon, and
 * without a `<link rel="icon">` the browser asks the app for `/favicon.ico`.
 */
const NO_FAVICON = 'data:,';

/**
 * A Scalar shell: the standalone bundle, the document embedded as JSON, and one
 * call to `Scalar.createApiReference`. The stylesheet is inside the bundle, which
 * injects it as a `<style>` on load, so there is no `<link>`.
 *
 * `content` is assigned after the options object so a caller cannot point the
 * page at another document.
 */
export const renderScalarPage = (
  document: OpenApiDocument,
  options: PageOptions,
  assets: PackageAssets,
  scalar: ScalarOptions = {},
): string =>
  renderShell(document, {
    mountId: MOUNT_ELEMENT_ID,
    jsonHref: options.jsonHref,
    ...(scalar.title === undefined ? {} : { title: scalar.title }),
    icon: scalar.favicon ?? NO_FAVICON,
    scripts: [assets.href(options.mountedAt, 'standalone.js')],
    boot:
      '(function(){' +
      readDocument('content') +
      `var options=${renderScalarOptions(scalar)};` +
      'options.content=content;' +
      `Scalar.createApiReference(${JSON.stringify(`#${MOUNT_ELEMENT_ID}`)},options);` +
      '})();',
  });
