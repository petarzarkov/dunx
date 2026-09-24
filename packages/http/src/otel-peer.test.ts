import { describe, expect, it } from 'bun:test';

/**
 * `@opentelemetry/api` is an optional peer of `@dunx/core/otel`, and a static
 * import of an absent one fails the whole graph. Every entry here opens spans
 * through core's `Tracer` instead, so none of them may reach it. Bundled with
 * packages external, the output names exactly the packages an entry imports.
 */
describe('no @dunx/http entry imports @opentelemetry/api', () => {
  it.each(['index.ts', 'client.ts', 'connect.ts', 'internal.ts'])(
    '%s',
    async (entry) => {
      const built = await Bun.build({
        entrypoints: [`${import.meta.dir}/${entry}`],
        packages: 'external',
        target: 'bun',
      });
      const text = (await built.outputs[0]?.text()) ?? '';
      expect(text).toContain('@dunx/core');
      expect(text).not.toContain('@opentelemetry/api');
    },
  );
});
