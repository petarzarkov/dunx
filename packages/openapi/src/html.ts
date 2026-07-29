import { COMPONENTS_PREFIX } from './refs.js';
import {
  OPERATION_ORDER,
  type JsonSchema,
  type OpenApiDocument,
  type OperationKey,
  type OperationObject,
  type ParameterObject,
} from './types.js';

/**
 * The page is written here, in full, with no CDN and no bundled copy of anyone
 * else's viewer: one `<style>` block, `<details>` for the folding, and nothing that
 * needs to be fetched. `Bun.escapeHTML` does the escaping and `Bun.markdown` renders
 * the prose — both native, so this file is a renderer rather than a dependency.
 */
const STYLE = `
:root {
  color-scheme: light dark;
  --bg: #fbfbfd; --fg: #16161a; --muted: #5b5b66; --line: #e2e2ea;
  --card: #ffffff; --code: #f4f4f8; --accent: #3b5bdb;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #14141a; --fg: #ececf2; --muted: #a0a0ae; --line: #2a2a35;
    --card: #1c1c24; --code: #121218; --accent: #91a7ff;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0; padding: 2.5rem 1.25rem 6rem; background: var(--bg); color: var(--fg);
  font: 15px/1.6 ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
}
main { max-width: 62rem; margin: 0 auto; }
h1 { font-size: 1.65rem; margin: 0 0 .25rem; }
h2 {
  font-size: 1.1rem; margin: 2.5rem 0 .75rem; text-transform: uppercase;
  letter-spacing: .08em; color: var(--muted);
}
a { color: var(--accent); }
.sub { color: var(--muted); margin: 0 0 1.5rem; }
.pill {
  display: inline-block; padding: .1rem .5rem; border: 1px solid var(--line);
  border-radius: 999px; font-size: .75rem; color: var(--muted); margin-right: .35rem;
}
.op {
  background: var(--card); border: 1px solid var(--line); border-radius: .6rem;
  margin: .5rem 0; overflow: hidden;
}
.op > summary {
  cursor: pointer; padding: .7rem .9rem; display: flex; gap: .6rem;
  align-items: center; flex-wrap: wrap; list-style: none;
}
.op > summary::-webkit-details-marker { display: none; }
.op[open] > summary { border-bottom: 1px solid var(--line); }
.op:target { border-color: var(--accent); }
.verb {
  font: 600 .72rem/1.4 ui-monospace, SFMono-Regular, Menlo, monospace;
  letter-spacing: .06em; padding: .2rem .45rem; border-radius: .3rem;
  color: #fff; background: #5b5b66; min-width: 4.2rem; text-align: center;
}
.verb.get { background: #1971c2; } .verb.post { background: #2f9e44; }
.verb.put { background: #e8590c; } .verb.patch { background: #9c36b5; }
.verb.delete { background: #c92a2a; }
.route { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.sum { color: var(--muted); }
.body { padding: .3rem .9rem 1rem; }
h3 {
  font-size: .8rem; text-transform: uppercase; letter-spacing: .07em;
  color: var(--muted); margin: 1.1rem 0 .4rem;
}
table { border-collapse: collapse; width: 100%; font-size: .9rem; }
th, td { text-align: left; padding: .35rem .5rem; border-bottom: 1px solid var(--line); }
th { color: var(--muted); font-weight: 600; }
code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .85em; }
pre {
  background: var(--code); border: 1px solid var(--line); border-radius: .4rem;
  padding: .7rem .8rem; overflow-x: auto; margin: .3rem 0;
}
.warn {
  background: #fff4e6; border: 1px solid #ffa94d; color: #7a3d00;
  border-radius: .5rem; padding: .7rem .9rem; margin: 1rem 0;
}
@media (prefers-color-scheme: dark) {
  .warn { background: #2b1d0e; border-color: #b1650f; color: #ffc994; }
}
.warn ul { margin: .35rem 0 0; padding-left: 1.2rem; }
.prose > :first-child { margin-top: 0; }
.prose > :last-child { margin-bottom: 0; }
`;

const escape = (value: string): string => Bun.escapeHTML(value);

/**
 * Author-written prose. Bun parses the markdown; nothing here reimplements it. Raw
 * HTML is turned off in the parser rather than trusted — a description reaching this
 * page came from a schema, and a schema can come from anywhere.
 */
const prose = (markdown: string): string =>
  `<div class="prose">${Bun.markdown.html(markdown, {
    noHtmlBlocks: true,
    noHtmlSpans: true,
    tagFilter: true,
  })}</div>`;

const json = (value: unknown): string =>
  `<pre><code>${escape(JSON.stringify(value, null, 2))}</code></pre>`;

/** `#/components/schemas/Tag` -> `Tag`, and only for a schema that is just a ref. */
const refName = (schema: JsonSchema): string | undefined => {
  const ref = schema['$ref'];
  return typeof ref === 'string' && ref.startsWith(COMPONENTS_PREFIX)
    ? ref.slice(COMPONENTS_PREFIX.length)
    : undefined;
};

const anchorOf = (name: string): string => `schema-${encodeURIComponent(name)}`;

/**
 * A `$ref` is rendered as a same-page link to the definition rather than as the ref
 * string. A fragment link needs nothing fetched, so the page stays self-contained.
 */
const schemaCell = (schema: JsonSchema): string => {
  const name = refName(schema);
  return name === undefined
    ? `<code>${escape(JSON.stringify(schema))}</code>`
    : `<a href="#${escape(anchorOf(name))}"><code>${escape(name)}</code></a>`;
};

const schemaBody = (schema: JsonSchema): string => {
  const name = refName(schema);
  return name === undefined ? json(schema) : `<p>${schemaCell(schema)}</p>`;
};

const parameterTable = (parameters: readonly ParameterObject[]): string => {
  const rows = parameters
    .map(
      (parameter) =>
        `<tr><td><code>${escape(parameter.name)}</code></td>` +
        `<td>${escape(parameter.in)}</td>` +
        `<td>${parameter.required === true ? 'yes' : 'no'}</td>` +
        `<td>${schemaCell(parameter.schema)}</td></tr>`,
    )
    .join('');

  return (
    '<h3>Parameters</h3><table><thead><tr><th>Name</th><th>In</th>' +
    `<th>Required</th><th>Schema</th></tr></thead><tbody>${rows}</tbody></table>`
  );
};

const securityLine = (operation: OperationObject): string => {
  const security = operation.security;
  if (security === undefined) return '';
  if (security.length === 0) {
    return (
      '<h3>Security</h3><p><span class="pill">public</span>no requirement — ' +
      'the route declared <code>@Public()</code>.</p>'
    );
  }

  const schemes = security
    .flatMap((requirement) => Object.keys(requirement))
    .map((name) => `<code>${escape(name)}</code>`)
    .join(', ');
  const roles = operation['x-required-roles'];
  const suffix =
    roles === undefined
      ? ''
      : ` Roles: ${roles.map((role) => `<code>${escape(role)}</code>`).join(', ')}.`;

  return `<h3>Security</h3><p>${schemes}${suffix}</p>`;
};

const responseList = (operation: OperationObject): string => {
  const rows = Object.entries(operation.responses)
    .map(([status, response]) => {
      const media = Object.entries(response.content ?? {})
        .map(
          ([type, value]) =>
            `<td>${escape(type)}</td><td>${schemaCell(value.schema)}</td>`,
        )
        .join('');
      return (
        `<tr><td><code>${escape(status)}</code></td>` +
        `<td>${escape(response.description)}</td>${media || '<td></td><td></td>'}</tr>`
      );
    })
    .join('');

  return (
    '<h3>Responses</h3><table><thead><tr><th>Status</th><th>Meaning</th>' +
    `<th>Media type</th><th>Schema</th></tr></thead><tbody>${rows}</tbody></table>`
  );
};

const operationBlock = (
  path: string,
  method: OperationKey,
  operation: OperationObject,
): string => {
  const summary = operation.summary ?? '';
  const deprecated =
    operation.deprecated === true ? '<span class="pill">deprecated</span>' : '';
  const body = operation.requestBody;

  return (
    '<details class="op"><summary>' +
    `<span class="verb ${method}">${method.toUpperCase()}</span>` +
    `<span class="route">${escape(path)}</span>` +
    `<span class="sum">${escape(summary)}</span>${deprecated}` +
    '</summary><div class="body">' +
    `<p class="sub"><code>${escape(operation.operationId)}</code></p>` +
    (operation.description !== undefined ? prose(operation.description) : '') +
    (operation.parameters !== undefined
      ? parameterTable(operation.parameters)
      : '') +
    (body !== undefined
      ? Object.entries(body.content)
          .map(
            ([type, value]) =>
              `<h3>Request body — ${escape(type)}</h3>${schemaBody(value.schema)}`,
          )
          .join('')
      : '') +
    responseList(operation) +
    securityLine(operation) +
    '</div></details>'
  );
};

interface Entry {
  readonly path: string;
  readonly method: OperationKey;
  readonly operation: OperationObject;
}

const byTag = (document: OpenApiDocument): Map<string, Entry[]> => {
  const grouped = new Map<string, Entry[]>();

  for (const [path, item] of Object.entries(document.paths)) {
    for (const method of OPERATION_ORDER) {
      const operation = item[method];
      if (operation === undefined) continue;
      for (const tag of operation.tags ?? ['default']) {
        const entries = grouped.get(tag) ?? [];
        entries.push({ path, method, operation });
        grouped.set(tag, entries);
      }
    }
  }

  return grouped;
};

export interface PageOptions {
  /** Where the JSON document is served, so the page can link to it. */
  readonly jsonHref: string;
  readonly warnings: readonly string[];
}

/**
 * A whole page in one string: no CDN, no bundled viewer, no fetch. Everything it
 * shows is already in the document it was handed, which is also why it needs no
 * JavaScript to be useful.
 */
export const renderPage = (
  document: OpenApiDocument,
  options: PageOptions,
): string => {
  const grouped = byTag(document);
  const sections = [...grouped.keys()]
    .sort()
    .map((tag) => {
      const entries = grouped.get(tag) ?? [];
      const blocks = entries
        .map((entry) =>
          operationBlock(entry.path, entry.method, entry.operation),
        )
        .join('');
      return `<h2>${escape(tag)}</h2>${blocks}`;
    })
    .join('');

  const schemas = Object.entries(document.components.schemas)
    .map(
      ([name, schema]) =>
        `<details class="op" id="${escape(anchorOf(name))}"><summary>` +
        `<span class="route">${escape(name)}</span></summary>` +
        `<div class="body">${json(schema)}</div></details>`,
    )
    .join('');

  const warnings =
    options.warnings.length === 0
      ? ''
      : '<div class="warn"><strong>Generated with warnings</strong><ul>' +
        options.warnings.map((line) => `<li>${escape(line)}</li>`).join('') +
        '</ul></div>';

  const servers = (document.servers ?? [])
    .map((server) => `<span class="pill">${escape(server.url)}</span>`)
    .join('');

  return (
    '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    `<title>${escape(document.info.title)} ${escape(document.info.version)}</title>` +
    `<style>${STYLE}</style></head><body><main>` +
    `<h1>${escape(document.info.title)}</h1>` +
    `<p class="sub"><span class="pill">OpenAPI ${escape(document.openapi)}</span>` +
    `<span class="pill">v${escape(document.info.version)}</span>${servers}` +
    `<a href="${escape(options.jsonHref)}">openapi.json</a></p>` +
    (document.info.description !== undefined
      ? prose(document.info.description)
      : '') +
    warnings +
    sections +
    (schemas === '' ? '' : `<h2>Schemas</h2>${schemas}`) +
    '</main></body></html>'
  );
};
