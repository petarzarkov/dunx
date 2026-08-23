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

  /** Served by a controller in the same graph, so it goes through the same
   * middleware and describes the paths the app really mounted. */
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
    // A named response schema becomes a component the operation $refs. It is
    // documentation only: nothing validates a response.
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

    // A $ref resolving to nothing renders as an empty box and reports no error.
    logger.info(
      `unresolved $refs: ${danglingRefs(document).length}, warnings: ` +
        JSON.stringify(app.get(OpenApiExplorer).warnings),
    );

    const page = await fetch(new URL('api/docs', url));
    const html = await page.text();
    logger.info(
      `GET /api/docs -> ${page.status} ${page.headers.get('content-type')}, ` +
        `${html.length} bytes of Swagger UI shell`,
    );

    /**
     * The page fetches two `swagger-ui-dist` assets, and the guarantee is that
     * they are same-origin: no CDN. Script bodies are stripped first, since a
     * `src=` inside a `<script>` is text rather than a resource.
     */
    const shell = html.replace(/(<script[^>]*>)[\s\S]*?(<\/script>)/g, '$1$2');
    const requested = [
      ...shell.matchAll(/<(?:script|link)\b[^>]*\s(?:src|href)="([^"]*)"/g),
    ]
      .map(([, href]) => href ?? '')
      .filter((href) => !href.startsWith('data:'));
    const offOrigin = requested.filter((href) => /^[a-z]+:|^\/\//i.test(href));
    logger.info(
      `  requests ${requested.length} asset(s), ${offOrigin.length} off-origin: ` +
        JSON.stringify(requested),
    );

    // Each has to answer, resolving out of the consumer's own install.
    for (const href of requested) {
      const asset = await fetch(new URL(href.replace(/^\//, ''), url));
      logger.info(
        `  ${href.split('?')[0]} -> ${asset.status} ` +
          `${asset.headers.get('content-type')}, ` +
          `${Number(asset.headers.get('content-length') ?? 0).toLocaleString('en-US')} bytes, ` +
          `cache-control: ${asset.headers.get('cache-control')}`,
      );
    }
  }

  /** Security in the document comes from the same `@Public()` and `@Roles()`
   * metadata the guards read at runtime. */
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

    // A class-level @Roles merges into every route, so it is documented here
    // too. The document describes the metadata; enforcement is a separate call.
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
