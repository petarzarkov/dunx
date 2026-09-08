/**
 * The demo's card, committed as `src/landing/public/og.png` and served at
 * `/og.png`. Drawn through `scripts/og-card.ts`, which the site's card also
 * uses; only the words differ. `bun run gen:og` regenerates it.
 */

import {
  OG_HEIGHT,
  OG_WIDTH,
  ogLogo,
  renderCard,
  reportCard,
} from '../../../scripts/og-card.js';

/** What the panels call, in the order they appear. */
const CHIPS = [
  'websockets',
  'queues',
  'transactions',
  'openapi',
  'rate limits',
] as const;

const cardHtml = (): string => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: ${OG_WIDTH}px; height: ${OG_HEIGHT}px; }
  body {
    position: relative;
    overflow: hidden;
    background:
      radial-gradient(900px 520px at 88% -8%, rgba(76, 195, 138, 0.22), transparent 70%),
      radial-gradient(760px 460px at 4% 106%, rgba(76, 110, 245, 0.20), transparent 70%),
      linear-gradient(140deg, #070a0e 0%, #101820 58%, #0a0f14 100%);
    color: #e6edf3;
    font-family: 'Inter', 'Segoe UI', 'Helvetica Neue', Arial, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  /* The site's card lattice, so the two read as one family. */
  .grid {
    position: absolute; inset: 0;
    background-image:
      linear-gradient(to right, rgba(148, 163, 184, 0.10) 1px, transparent 1px),
      linear-gradient(to bottom, rgba(148, 163, 184, 0.10) 1px, transparent 1px);
    background-size: 54px 54px;
    mask-image: radial-gradient(120% 100% at 50% 0%, #000 35%, transparent 78%);
  }
  .card {
    position: relative; height: 100%; padding: 56px 68px;
    display: flex; flex-direction: column; justify-content: space-between;
  }
  .brand { display: flex; align-items: center; gap: 16px; }
  .brand span { font-size: 46px; font-weight: 700; letter-spacing: -0.02em; }
  .live {
    margin-left: 10px; padding: 7px 16px; border-radius: 999px;
    font: 600 19px ui-monospace, 'SFMono-Regular', Menlo, monospace;
    color: #4cc38a; border: 1px solid rgba(76, 195, 138, 0.45);
    background: rgba(76, 195, 138, 0.10);
  }
  h1 {
    font-size: 62px; line-height: 1.08; font-weight: 800; letter-spacing: -0.03em;
  }
  .accent {
    background-image: linear-gradient(96deg, #4cc38a, #3bc9db 55%, #748ffc);
    -webkit-background-clip: text; background-clip: text; color: transparent;
  }
  p { margin-top: 22px; font-size: 25px; line-height: 1.45; color: #9aa7b4; max-width: 50ch; }
  p b { color: #cbd5e1; font-weight: 600; }
  .chips { display: flex; gap: 12px; }
  .chip {
    padding: 9px 18px; border-radius: 9px; font-size: 20px;
    border: 1px solid rgba(148, 163, 184, 0.28); color: #ccd4e4;
    font-family: ui-monospace, 'SFMono-Regular', Menlo, monospace;
  }
  .chip:first-child { border-color: rgba(76, 195, 138, 0.55); color: #9fe3c2; }
</style>
</head>
<body>
  <div class="grid"></div>
  <div class="card">
    <div class="brand">${ogLogo()}<span>dunx</span><span class="live">live demo</span></div>
    <div>
      <h1>Every part of the framework,<br /><span class="accent">running on a Raspberry Pi.</span></h1>
      <p>
        <b>examples/full</b> from the repository, unmodified. Click a panel and it
        calls the same routes the tests and the OpenAPI document are generated from.
      </p>
    </div>
    <div class="chips">
      ${CHIPS.map((chip) => `<span class="chip">${chip}</span>`).join('')}
    </div>
  </div>
</body>
</html>
`;

if (import.meta.main) {
  const target = Bun.fileURLToPath(
    new URL('../src/landing/public/og.png', import.meta.url),
  );
  reportCard('demo og:image', await renderCard(target, cardHtml()));
}
