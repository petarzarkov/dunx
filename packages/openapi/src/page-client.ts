/**
 * The only JavaScript on the page, inlined as a `<script>` body.
 *
 * It exists so a route can be *sent*, which is the one thing a static rendering
 * cannot do and the reason people reach for swagger-ui. Everything else on the
 * page still works with scripting off — the forms are the enhancement, not the
 * content.
 *
 * Written against the DOM directly rather than bundled from a source file: it is
 * ~90 lines, it must not be fetched, and a build step that produced it would put
 * a bundler between `@dunx/openapi` and a string it already knows how to write.
 *
 * Must never contain the closing script tag as a literal — hence `<\/`.
 */
export const CLIENT = String.raw`
(() => {
  const text = (node, value) => { node.textContent = value; };

  const fill = (template, form) => {
    let path = template;
    for (const input of form.querySelectorAll('[data-in="path"]')) {
      path = path.replace(
        '{' + input.dataset.name + '}',
        encodeURIComponent(input.value.trim()),
      );
    }
    const url = new URL(path, location.origin);
    for (const input of form.querySelectorAll('[data-in="query"]')) {
      const value = input.value.trim();
      if (value !== '') url.searchParams.set(input.dataset.name, value);
    }
    return url;
  };

  const headersOf = (form, hasBody) => {
    const headers = {};
    if (hasBody) headers['content-type'] = 'application/json';
    const raw = form.querySelector('[data-headers]');
    for (const line of (raw ? raw.value : '').split('\n')) {
      const at = line.indexOf(':');
      if (at < 1) continue;
      headers[line.slice(0, at).trim()] = line.slice(at + 1).trim();
    }
    return headers;
  };

  const render = async (out, response, ms) => {
    const type = response.headers.get('content-type') || '';
    let body = await response.text();
    if (type.includes('json')) {
      try { body = JSON.stringify(JSON.parse(body), null, 2); } catch {}
    }
    const shown = [...response.headers]
      .map(([k, v]) => k + ': ' + v)
      .sort()
      .join('\n');
    out.hidden = false;
    out.className = 'out ' + (response.ok ? 'ok' : 'bad');
    text(out.querySelector('[data-status]'),
      response.status + ' ' + response.statusText + '  ·  ' + ms + ' ms');
    text(out.querySelector('[data-headers-out]'), shown);
    text(out.querySelector('[data-body-out]'), body);
  };

  document.addEventListener('submit', async (event) => {
    const form = event.target;
    if (!form.matches('form.try')) return;
    event.preventDefault();

    const out = form.parentElement.querySelector('.out');
    const button = form.querySelector('button');
    const bodyBox = form.querySelector('[data-body]');
    const method = form.dataset.method.toUpperCase();
    const hasBody = Boolean(bodyBox) && method !== 'GET' && method !== 'HEAD';

    button.disabled = true;
    try {
      const started = performance.now();
      const response = await fetch(fill(form.dataset.path, form), {
        method,
        headers: headersOf(form, hasBody),
        ...(hasBody ? { body: bodyBox.value } : {}),
      });
      await render(out, response, Math.round(performance.now() - started));
    } catch (error) {
      out.hidden = false;
      out.className = 'out bad';
      text(out.querySelector('[data-status]'), 'Request failed');
      text(out.querySelector('[data-headers-out]'), '');
      text(out.querySelector('[data-body-out]'), String(error));
    } finally {
      button.disabled = false;
    }
  });
})();
`;
