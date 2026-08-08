import { describe, expect, it } from 'bun:test';
import { ago, bytes, count, duration } from './format';
import { hrefFor, panelFor } from './router';
import { readMeta } from './meta';

/**
 * The logic with no DOM: formatting, routing and the meta the server embeds. The
 * panels themselves are Mantine over data that arrives typed from
 * `packages/dashboard/src/api/types` - a rendering test of those would assert
 * Mantine's markup, which is not this bundle's contract.
 */
describe('format', () => {
  it('scales bytes and keeps one decimal above KiB', () => {
    expect(bytes(512)).toBe('512 B');
    expect(bytes(1536)).toBe('1.5 KiB');
    expect(bytes(28 * 1024 * 1024)).toBe('28.0 MiB');
  });

  it('shows at most two units and never a fractional one', () => {
    // `1.7 hours` takes longer to understand than `1h 42m`, which is the job.
    expect(duration(340)).toBe('340ms');
    expect(duration(12_000)).toBe('12s');
    expect(duration(250_000)).toBe('4m 10s');
    expect(duration(6_120_000)).toBe('1h 42m');
    expect(duration(180_000_000)).toBe('2d 2h');
  });

  it('measures age against the server clock, never the browser', () => {
    // A laptop minutes off UTC would otherwise render every job as enqueued in
    // the future, which reads as a bug in the queue rather than in the clock.
    expect(ago(1_000, 61_000)).toBe('1m 0s ago');
    expect(ago(0, 61_000)).toBe('-');
    // Never negative: a clock that has drifted the other way reads as "just now".
    expect(ago(90_000, 61_000)).toBe('0ms ago');
  });

  it('groups a count so six figures stay readable', () => {
    expect(count(41_237)).toBe('41,237');
  });
});

describe('router', () => {
  // Real paths, not a hash: the mount serves the page for any path under it, so
  // `/admin/_dunx/routes` reloads and bookmarks like a real URL.
  const base = '/admin/_dunx';

  it('reads the panel out of the first segment after the mount', () => {
    expect(panelFor(`${base}/routes`, base)).toBe('routes');
    expect(panelFor(`${base}/graph/anything/else`, base)).toBe('graph');
  });

  it('falls back to the overview rather than a 404', () => {
    // The server already decided this path is the dashboard's; the page's job is
    // to show something, not to argue.
    expect(panelFor(base, base)).toBe('overview');
    expect(panelFor(`${base}/`, base)).toBe('overview');
    expect(panelFor(`${base}/nonsense`, base)).toBe('overview');
  });

  it('builds hrefs against the mount, never against the root', () => {
    // An app behind a proxy at /admin/_dunx is the normal case.
    expect(hrefFor('routes', base)).toBe('/admin/_dunx/routes');
    expect(hrefFor('overview', base)).toBe('/admin/_dunx');
  });
});

describe('readMeta', () => {
  const withScript = (json: string): Document => {
    const doc = document.implementation.createHTMLDocument('t');
    const script = doc.createElement('script');
    script.type = 'application/json';
    script.id = 'dunx-dashboard-meta';
    script.textContent = json;
    doc.body.appendChild(script);
    return doc;
  };

  it('reads what the server embedded', () => {
    const meta = readMeta(
      withScript(
        '{"title":"x","basePath":"/admin/_dunx","pollMs":0,' +
          '"queuesPath":"/admin/_dunx/queues"}',
      ),
    );
    // The mount is read, never guessed: an app behind a proxy at /admin/_dunx is
    // the normal case, and every fetch the page makes is relative to this.
    expect(meta?.basePath).toBe('/admin/_dunx');
    // bull-board's mount is carried too rather than derived, so the page never
    // builds a URL the server did not agree to.
    expect(meta?.queuesPath).toBe('/admin/_dunx/queues');
  });

  it('is undefined rather than throwing on a page with no meta', () => {
    expect(
      readMeta(document.implementation.createHTMLDocument('t')),
    ).toBeUndefined();
    expect(readMeta(withScript('not json'))).toBeUndefined();
  });
});
