/**
 * The site's social card, drawn once and committed as `public/og.png`.
 *
 * `renderPage` had no `og:image` because every image the site ships is an SVG
 * and the unfurlers decline to render one, so a share of any dunx page produced
 * a bare link. That suppresses exactly the sharing that earns the links a new
 * domain needs.
 *
 * Only the words live here. The screenshot itself is `scripts/og-card.ts`, which
 * `examples/full` draws its own card with. `bun run gen:og` regenerates both.
 *
 * The words come from `scripts/positioning.ts`, so the card cannot say something
 * the hero and the README do not.
 */

import {
  OG_HEIGHT,
  OG_WIDTH,
  ogLogo,
  renderCard,
  reportCard,
} from '../../../scripts/og-card.js';
import { BLURB, CHIPS, HEADLINE } from '../../../scripts/positioning.js';
import { escapeHtml } from './pages.js';

const WIDTH = OG_WIDTH;
const HEIGHT = OG_HEIGHT;
const LOGO = ogLogo();

export const cardHtml = (): string => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: ${WIDTH}px; height: ${HEIGHT}px; }
  body {
    position: relative;
    overflow: hidden;
    background:
      radial-gradient(900px 520px at 88% -8%, rgba(76, 110, 245, 0.28), transparent 70%),
      radial-gradient(760px 460px at 4% 106%, rgba(121, 80, 242, 0.22), transparent 70%),
      linear-gradient(140deg, #080c19 0%, #101736 58%, #0a0f24 100%);
    color: #f4f6fb;
    font-family: 'Inter', 'Segoe UI', 'Helvetica Neue', Arial, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  /* The 54px lattice the hero uses, faded out the same way. */
  .grid {
    position: absolute; inset: 0;
    background-image:
      linear-gradient(to right, rgba(148, 163, 184, 0.10) 1px, transparent 1px),
      linear-gradient(to bottom, rgba(148, 163, 184, 0.10) 1px, transparent 1px);
    background-size: 54px 54px;
    mask-image: radial-gradient(120% 100% at 50% 0%, #000 35%, transparent 78%);
  }
  /* space-between rather than a pair of auto top margins, which fought each
     other and pushed the chips off the 630px canvas. */
  .card {
    position: relative; height: 100%; padding: 56px 68px;
    display: flex; flex-direction: column; justify-content: space-between;
  }
  .brand { display: flex; align-items: center; gap: 16px; }
  .brand span { font-size: 46px; font-weight: 700; letter-spacing: -0.02em; }
  h1 {
    font-size: 58px; line-height: 1.1; font-weight: 800; letter-spacing: -0.03em;
  }
  .accent {
    background-image: linear-gradient(96deg, #748ffc, #9775fa 42%, #3bc9db);
    -webkit-background-clip: text; background-clip: text; color: transparent;
  }
  p { margin-top: 20px; font-size: 24px; line-height: 1.45; color: #aab4c8; max-width: 53ch; }
  .chips { display: flex; gap: 12px; }
  .chip {
    padding: 9px 18px; border-radius: 9px; font-size: 21px;
    border: 1px solid rgba(148, 163, 184, 0.28); color: #ccd4e4;
    font-family: ui-monospace, 'SFMono-Regular', Menlo, monospace;
  }
  .chip:first-child { border-color: rgba(116, 143, 252, 0.6); color: #b9c6ff; }
</style>
</head>
<body>
  <div class="grid"></div>
  <div class="card">
    <div class="brand">${LOGO}<span>dunx</span></div>
    <div>
      <h1>${escapeHtml(HEADLINE[0])}<br /><span class="accent">${escapeHtml(HEADLINE[1])}</span></h1>
      <p>${escapeHtml(BLURB)}</p>
    </div>
    <div class="chips">
      ${CHIPS.map((chip) => `<span class="chip">${escapeHtml(chip)}</span>`).join('')}
    </div>
  </div>
</body>
</html>
`;

if (import.meta.main) {
  const target = Bun.fileURLToPath(
    new URL('../public/og.png', import.meta.url),
  );
  reportCard('og:image', await renderCard(target, cardHtml()));
}
