import { describe, expect, it } from 'bun:test';

/**
 * A static import of an absent optional peer fails the whole module graph, so
 * `@opentelemetry/api` may be reached from `/otel` and from nothing the root
 * entry loads. Bundled with every package external: what is left in the output
 * is exactly the set of packages the entry imports.
 */
const imports = async (entry: string): Promise<string> => {
  const built = await Bun.build({
    entrypoints: [`${import.meta.dir}/../${entry}`],
    packages: 'external',
    target: 'bun',
  });
  const [output] = built.outputs;
  if (output === undefined) throw new Error(`nothing built from ${entry}`);
  return output.text();
};

describe('@opentelemetry/api stays an optional peer', () => {
  it('is not imported by the root entry', async () => {
    expect(await imports('index.ts')).not.toContain('@opentelemetry/api');
  });

  it('is imported by /otel, which is the point of the subpath', async () => {
    expect(await imports('otel/index.ts')).toContain('@opentelemetry/api');
  });
});
