import { Logger } from '@dunx/core';
import type { HttpApp } from '@dunx/http';
import {
  danglingRefs,
  OpenApiExplorer,
  type OpenApiDocument,
} from '@dunx/openapi';

const documentAt = async (
  url: string,
  path = 'api/openapi.json',
): Promise<[Response, OpenApiDocument]> => {
  const response = await fetch(new URL(path, url));
  return [response, (await response.json()) as OpenApiDocument];
};

export class DocsDemo {
  constructor(private readonly logger: Logger) {}

  /**
   * The document is served by a controller in the same graph, so it goes through the
   * same middleware and the same CORS as everything else - and describes the paths
   * the app really mounted, `setGlobalPrefix('api')` included.
   */
  async demonstrate(app: HttpApp, url: string): Promise<void> {
    const { logger } = this;
    const [response, document] = await documentAt(url);

    logger.info(
      `GET /api/openapi.json -> ${response.status} openapi ${document.openapi}, ` +
        `${Object.keys(document.paths).length} paths`,
    );
    logger.info(`paths: ${JSON.stringify(Object.keys(document.paths))}`);
    logger.info(
      `components/schemas: ${JSON.stringify(Object.keys(document.components.schemas))}`,
    );

    // `.meta({ id: 'CreateUser' })` on the zod schema is what named this ref, and
    // the $defs entry it referenced (`Tag`) came along with it.
    const create = document.paths['/api/users']?.post;
    logger.info(
      `POST /api/users requestBody -> ` +
        JSON.stringify(
          create?.requestBody?.content['application/json']?.schema,
        ),
    );
    logger.info(
      `POST /api/users 400 -> ` +
        JSON.stringify(create?.responses['400']?.content?.['application/json']),
    );
    // `options.response` is the same contract as the request side, so a named
    // response schema becomes a component and the operation $refs it. It is
    // documentation only - nothing validates a response.
    const one = document.paths['/api/users/{id}']?.get;
    logger.info(
      `GET /api/users/{id} responses -> ` +
        JSON.stringify(
          Object.fromEntries(
            Object.entries(one?.responses ?? {}).map(([status, response]) => [
              status,
              response.content?.['application/json']?.schema,
            ]),
          ),
        ),
    );
    const list = document.paths['/api/users']?.get;
    logger.info(`GET /api/users query -> ${JSON.stringify(list?.parameters)}`);

    // The check that matters: a $ref that resolves to nothing renders as an empty
    // box in every viewer and reports no error at all.
    logger.info(
      `unresolved $refs: ${danglingRefs(document).length}, warnings: ` +
        JSON.stringify(app.get(OpenApiExplorer).warnings),
    );

    const page = await fetch(new URL('api/docs', url));
    const html = await page.text();
    // Two inline scripts: the document as JSON, and the explorer bundle. What
    // still has to hold is that nothing is *fetched* - so the check is on the
    // markup, with both script bodies removed. Inside a <script> everything is
    // text, and minified React's own string table contains `src=` and `<script`.
    const shell = html.replace(/(<script[^>]*>)[\s\S]*?(<\/script>)/g, '$1$2');
    // A `<link>` counts only if it would actually fetch. The page carries one
    // for its favicon, as a `data:` URI, which the browser never requests.
    const fetchedLink = [...shell.matchAll(/<link\b[^>]*href="([^"]*)"/g)].some(
      ([, href]) => href !== undefined && !href.startsWith('data:'),
    );
    const external =
      /\ssrc=/.test(shell) ||
      fetchedLink ||
      /url\(\s*["']?(https?:)?\/\//.test(html) ||
      html.includes('//cdn');
    logger.info(
      `GET /api/docs -> ${page.status} ${page.headers.get('content-type')}, ` +
        `${html.length} bytes, ${(html.match(/<\/script>/g) ?? []).length} inline scripts, ` +
        `external requests: ${external ? 'some' : 'none'}`,
    );
  }

  /**
   * The guarded app, whose `AuthGuard` is global. Security in the document comes from
   * the same `@Public()` and `@Roles()` metadata the guards read at runtime - there
   * is no second annotation for the documentation to disagree with.
   */
  async guarded(url: string): Promise<void> {
    const { logger } = this;
    const [, document] = await documentAt(url);

    const rename = document.paths['/api/reports/{id}']?.patch;
    logger.info(
      `@Roles("editor") PATCH /api/reports/{id} -> security ` +
        `${JSON.stringify(rename?.security)}, roles ` +
        `${JSON.stringify(rename?.['x-required-roles'])}`,
    );

    const health = document.paths['/api/reports/health']?.get;
    logger.info(
      `@Public() GET /api/reports/health -> security ${JSON.stringify(health?.security)}`,
    );

    // The class-level @Roles('admin') is merged into every one of its routes, so it
    // is documented on this one too - even though no RolesGuard reads it here. The
    // document describes what the metadata declares; which guard enforces it is a
    // separate decision, and one no generator can see.
    const list = document.paths['/api/reports']?.get;
    logger.info(
      `class-level @Roles("admin") GET /api/reports -> security ` +
        `${JSON.stringify(list?.security)}, roles ` +
        `${JSON.stringify(list?.['x-required-roles'])}`,
    );
    logger.info(
      `securitySchemes: ${JSON.stringify(document.components.securitySchemes)}`,
    );
  }
}
