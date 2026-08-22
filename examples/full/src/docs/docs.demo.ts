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
    logger.info(
      `GET /api/docs -> ${page.status} ${page.headers.get('content-type')}, ` +
        `${html.length} bytes of Swagger UI shell`,
    );

    /**
     * **The page fetches, and this is the check that it only fetches from here.**
     * The explorer used to be dunx's own bundle inlined into the page, so the
     * assertion was that nothing was requested at all. It is now `swagger-ui-dist`,
     * 3.7x the size gzipped, served as two assets - so the guarantee is narrower and
     * has to be stated as what it is: same-origin only, no CDN.
     *
     * Script bodies are stripped first. Inside a `<script>` everything is text, so a
     * `src=` in the boot script is not a resource.
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

    // Every one of them has to actually answer, which is the half a unit test
    // cannot show: these resolve out of the consumer's own swagger-ui-dist
    // install, through this app's global prefix.
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
