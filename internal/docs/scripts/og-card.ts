/**
 * The site's social card, drawn once and committed as `public/og.png`.
 *
 * `renderPage` had no `og:image` because every image the site ships is an SVG
 * and the unfurlers decline to render one, so a share of any dunx page produced
 * a bare link. That suppresses exactly the sharing that earns the links a new
 * domain needs.
 *
 * Only the colours and the words live here. The shell and the screenshot are
 * `scripts/og-card.ts`, which `examples/full` draws its own card with, and
 * `bun run gen:og` regenerates both.
 *
 * The words come from `scripts/positioning.ts`, so the card cannot say something
 * the hero and the README do not.
 */

import {
  cardHtml,
  renderCard,
  reportCard,
  type CardContent,
  type CardStyle,
} from '../../../scripts/og-card.js';
import { BLURB, CHIPS, HEADLINE } from '../../../scripts/positioning.js';
import { escapeHtml } from './pages.js';

const style: CardStyle = {
  background:
    'radial-gradient(900px 520px at 88% -8%, rgba(76, 110, 245, 0.28), transparent 70%), ' +
    'radial-gradient(760px 460px at 4% 106%, rgba(121, 80, 242, 0.22), transparent 70%), ' +
    'linear-gradient(140deg, #080c19 0%, #101736 58%, #0a0f24 100%)',
  ink: '#f4f6fb',
  dim: '#aab4c8',
  accent: 'linear-gradient(96deg, #748ffc, #9775fa 42%, #3bc9db)',
  chipAccent: 'rgba(116, 143, 252, 0.85)',
  chipInk: '#ccd4e4',
};

/** Escaped here: these come from `positioning.ts` rather than from this file,
 * and the shell inserts what it is given. */
const content: CardContent = {
  headline: [escapeHtml(HEADLINE[0]), escapeHtml(HEADLINE[1])],
  blurb: escapeHtml(BLURB),
  chips: CHIPS.map((chip) => escapeHtml(chip)),
};

export const siteCard = (): string => cardHtml(style, content);

if (import.meta.main) {
  const target = Bun.fileURLToPath(
    new URL('../public/og.png', import.meta.url),
  );
  reportCard('og:image', await renderCard(target, siteCard()));
}
