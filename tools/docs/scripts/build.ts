import { rm } from 'node:fs/promises';

/**
 * `Bun.build` over the HTML entrypoint, in place of Vite.
 *
 * Bun resolves `<script type="module">` out of the HTML, transpiles the TSX,
 * bundles the CSS Mantine imports, hashes both and rewrites the tags — which is
 * everything this site was using Vite for. Measured on this repo: 41 ms against
 * Vite's 1.7 s, at the cost of ~25% more gzipped JS, because Bun's minifier
 * tree-shakes Mantine less aggressively. For a docs site that is the right side
 * of the trade; the reasoning is in ARCHITECTURE.md, "Documentation site".
 *
 * Served from https://petarzarkov.github.io/dunx/, so every asset URL needs the
 * repository name as its prefix. `DOCS_BASE=/` builds for a local server.
 */
const base = Bun.env['DOCS_BASE'] ?? '/dunx/';
const outdir = new URL('../dist/', import.meta.url).pathname;

await rm(outdir, { recursive: true, force: true });

const result = await Bun.build({
  entrypoints: [new URL('../index.html', import.meta.url).pathname],
  outdir,
  publicPath: base,
  minify: true,
  sourcemap: 'none',
  naming: {
    asset: 'assets/[name]-[hash].[ext]',
    chunk: 'assets/[name]-[hash].[ext]',
  },
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

// `public/` is copied verbatim: the coverage badges the README links to live
// there, and the bundler has no reason to touch them.
const shell = new Bun.Glob('**/*');
let copied = 0;
for await (const entry of shell.scan({
  cwd: new URL('../public/', import.meta.url).pathname,
  onlyFiles: true,
})) {
  const from = new URL(`../public/${entry}`, import.meta.url).pathname;
  await Bun.write(`${outdir}${entry}`, Bun.file(from));
  copied += 1;
}

const bytes = result.outputs.reduce((total, out) => total + out.size, 0);
console.log(
  `docs: ${result.outputs.length} outputs, ${copied} static files, ` +
    `${(bytes / 1024).toFixed(1)} KiB -> dist/`,
);
