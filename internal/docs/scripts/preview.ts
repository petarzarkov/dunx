/**
 * Serves the built site and drives it in a real browser.
 *
 * The four awkward parts, in one place: mounting `dist/` under the base path Vite
 * wrote into the asset urls, emulating a colour scheme, emulating a device pixel
 * ratio, and getting a hash route to load at all. `browser/site.browser.test.ts`
 * is the only consumer - it both asserts and writes the PNGs, so there is no
 * second traversal to drift from it.
 *
 * `Bun.WebView` rather than playwright: it drives the Chrome already on the
 * machine (and on `ubuntu-latest`) instead of a 150 MB download, and the whole
 * surface used here is `navigate`, `evaluate`, `screenshot` and two CDP calls.
 * The trade is recorded in docs/bun-apis.md.
 */

/** Vite writes absolute `/dunx/...` asset urls, so the server has to mount there. */
const BASE = '/dunx';

export const ROUTES = [
  ['landing', '#/'],
  ['guide', '#/guide/introduction'],
  ['guide-long', '#/guide/controllers'],
  ['api', '#/api/http'],
  ['benchmarks', '#/benchmarks'],
  ['releases', '#/releases'],
  ['coverage', '#/coverage'],
] as const;

export const VIEWPORTS = [
  ['desktop', 1440, 900],
  ['mobile', 393, 852],
] as const;

export const SCHEMES = ['light', 'dark'] as const;

export type Scheme = (typeof SCHEMES)[number];

export interface Preview {
  /** Navigate to a hash route and wait for it to have rendered a heading. */
  open(hash: string): Promise<void>;
  /** Emulate a viewport and a device pixel ratio. */
  view(width: number, height: number, ratio: number): Promise<void>;
  /** Emulate `prefers-color-scheme`. The site is `defaultColorScheme="auto"`. */
  scheme(scheme: Scheme): Promise<void>;
  heading(): Promise<string>;
  /** The painted background, which is how a colour scheme is observed. */
  background(): Promise<string>;
  /** Whether the page scrolls sideways, which is the one layout rule that holds
   * for every route at every width. */
  overflows(): Promise<boolean>;
  screenshot(): Promise<Blob>;
  /**
   * Page-side `console.*` since the last {@link Preview.open}, which is the only
   * way to see a runtime error the happy-dom suites cannot reach: a chunk that
   * fails to load, a recharts tree that throws on a real layout.
   */
  logged(): readonly ConsoleLine[];
  close(): Promise<void>;
}

export interface ConsoleLine {
  readonly type: string;
  readonly text: string;
}

const HEADING = 'document.querySelector("h1")?.textContent ?? ""';

export const startPreview = async (dist: string): Promise<Preview> => {
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname.replace(BASE, '');
      const file = Bun.file(
        `${dist}${path === '' || path === '/' ? 'index.html' : path.slice(1)}`,
      );
      if (await file.exists()) return new Response(file);
      return new Response(Bun.file(`${dist}index.html`));
    },
  });

  let logged: ConsoleLine[] = [];
  // Both emulations are per-target and survive a navigation, and `scheme` costs a
  // repaint wait, so re-applying the one already in force is skipped. 28 shots
  // would otherwise spend 4.2s of that wait re-setting what was already set.
  let applied = { scheme: '', width: 0, height: 0, ratio: 0 };
  const view = new Bun.WebView({
    width: 1440,
    height: 900,
    console: (type, ...args) => {
      logged.push({ type, text: args.map((arg) => String(arg)).join(' ') });
    },
  });
  let loads = 0;

  /**
   * A cache-busting query rather than the bare hash. `navigate()` never resolves
   * when only the hash changes, so a loop over routes hangs on the second one
   * (measured on Bun 1.4.0, in docs/bun-apis.md). Varying the search makes each
   * route a real navigation, which also means every shot is a cold load - the
   * path a reader following a link actually takes.
   */
  const open = async (hash: string): Promise<void> => {
    logged = [];
    loads += 1;
    await view.navigate(`${server.url.origin}${BASE}/?n=${loads}${hash}`);

    for (let attempt = 0; attempt < 200; attempt += 1) {
      if ((await view.evaluate<string>(HEADING)) !== '') break;
      await Bun.sleep(15);
    }
    // Fonts, charts and the syntax highlighter settle a frame or two after the
    // heading is up, and a screenshot taken before that catches the reflow.
    await Bun.sleep(250);
  };

  await open('#/');

  return {
    open,
    view: async (width, height, ratio) => {
      if (
        applied.width === width &&
        applied.height === height &&
        applied.ratio === ratio
      ) {
        return;
      }
      applied = { ...applied, width, height, ratio };
      await view.cdp('Emulation.setDeviceMetricsOverride', {
        width,
        height,
        deviceScaleFactor: ratio,
        mobile: false,
      });
    },
    scheme: async (scheme) => {
      if (applied.scheme === scheme) return;
      applied = { ...applied, scheme };
      await view.cdp('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-color-scheme', value: scheme }],
      });
      // The media-query listener repaints on the next frame.
      await Bun.sleep(150);
    },
    heading: () => view.evaluate<string>(HEADING),
    background: () =>
      view.evaluate<string>('getComputedStyle(document.body).backgroundColor'),
    overflows: () =>
      view.evaluate<boolean>(
        'document.documentElement.scrollWidth > window.innerWidth',
      ),
    screenshot: () => view.screenshot(),
    logged: () => logged,
    close: async () => {
      view.close();
      await server.stop(true);
    },
  };
};
