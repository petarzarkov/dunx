/**
 * The demo's card, committed as `src/landing/public/og.png` and served at
 * `/og.png`. Colours and words only; the shell is `scripts/og-card.ts`. They
 * differ from the site's on purpose: that card sells the framework, this one
 * sells the fact that it is running and can be poked at.
 */

import {
  cardHtml,
  renderCard,
  reportCard,
  type CardContent,
  type CardStyle,
} from '../../../scripts/og-card.js';

const style: CardStyle = {
  background:
    'radial-gradient(900px 520px at 88% -8%, rgba(76, 195, 138, 0.22), transparent 70%), ' +
    'radial-gradient(760px 460px at 4% 106%, rgba(76, 110, 245, 0.20), transparent 70%), ' +
    'linear-gradient(140deg, #070a0e 0%, #101820 58%, #0a0f14 100%)',
  ink: '#e6edf3',
  dim: '#9aa7b4',
  accent: 'linear-gradient(96deg, #4cc38a, #3bc9db 55%, #748ffc)',
  chipAccent: 'rgba(76, 195, 138, 0.75)',
  chipInk: '#ccd4e4',
};

/** Literals throughout, so there is nothing to escape. */
const content: CardContent = {
  badge: 'live demo',
  headline: ['Every part of the framework,', 'running on a Raspberry Pi.'],
  blurb:
    '<b>examples/full</b> from the repository, unmodified. Click a panel and it ' +
    'calls the same routes the tests and the OpenAPI document are generated from.',
  chips: ['websockets', 'queues', 'transactions', 'openapi', 'rate limits'],
};

if (import.meta.main) {
  const target = Bun.fileURLToPath(
    new URL('../src/landing/public/og.png', import.meta.url),
  );
  reportCard(
    'demo og:image',
    await renderCard(target, cardHtml(style, content)),
  );
}
