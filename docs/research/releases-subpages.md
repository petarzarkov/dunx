## Verdict

Ship it as `#/releases/<version>`. The router already parses that shape with no
change: `parseRoute` splits the path on `/` and returns
`{ kind: 'releases', slug: '2.0.1' }` (`internal/docs/src/router.ts:32`), and
`href(RouteKind.Releases, '2.0.1')` already emits `#/releases/2.0.1`
(`internal/docs/src/router.ts:42`). `App.tsx:237` throws the slug away today.

The whole feature is one dispatch line, one new page component in the file that
already holds the index page, and one link change on the index. No new generated
file, no change to `chunks.ts`, no growth in `index.json`, no change to
`scripts/changelog.ts`, `scripts/version.ts` or `ci.yml`.

Three findings that shape it:

1. **CI creates no GitHub release and no git tag.** `grep` for
   `gh release`, `git tag`, `refs/tags` across every `.ts`, `.tsx`, `.yml`,
   `.md` and `.json` outside `node_modules` returns nothing, and `git tag -l`
   is empty (0 tags). `scripts/version.ts` bumps manifests, writes
   `CHANGELOG.md`, publishes to npm and pushes one `chore(release):` commit.
   The link the owner wants would be pasted by hand into a release note drafted
   on github.com, unless a `gh release create` step is added.
2. **The release chunk stays one chunk.** `internal/docs/src/generated/releases.json`
   is 40,520 bytes for 35 releases, 11,236 bytes gzipped; the built chunk is
   `dist/assets/releases-BeHmC4RT.js` at 41,430 bytes raw, 11.01 kB gzipped.
   That is 4.0% of the entry chunk's 274.45 kB gzip, which the reader has
   already downloaded. Splitting it 35 ways loses cross-release compression and
   adds 35 lines to `chunks.ts` for no measurable gain.
3. **Nothing fails today.** The docs suite is 83 pass / 0 fail across 8 files.
   `links.test.tsx:12` already lists `RouteKind.Releases` in `SLUGLESS`, so any
   `#/releases/<anything>` link passes unchecked, and release bodies carry 174
   hrefs of which 0 are internal. Two test edits are worth making anyway.

## Pipeline as it stands today

A `release:` commit to a rendered card, hop by hop:

1. `getReleaseTrigger()` reads `git log -1` and matches the subject
   (`scripts/bump.ts:189`, `scripts/bump.ts:88`). Not a release commit,
   `version.ts` exits 0 (`scripts/version.ts:438-448`).
2. `lastReleaseSha()` finds the previous `chore(release): bump version to`
   commit (`scripts/bump.ts:202`, prefix at `scripts/bump.ts:20`), and
   `commitLogSinceLastRelease(since)` collects the range
   (`scripts/version.ts:340`).
3. `applyVersionBumps` moves every publishable manifest to one shared version:
   the highest present, bumped once (`scripts/version.ts:105-114`). Lockstep is
   a correctness requirement, argued at `scripts/version.ts:349-378`.
4. `writeChangelog(version, commits)` calls `renderRelease`
   (`scripts/version.ts:174`), which emits
   `## <version> - <YYYY-MM-DD>`, then the `release:` commit's own prose as a
   summary line, then one `###` section per group in the order
   `breaking, feat, fix, perf, refactor, docs, other`
   (`scripts/changelog.ts:52-60`, `scripts/changelog.ts:150-178`). Each entry is
   `- **scope**: summary ([#pr](...)) ([\`sha7\`](...))`
   (`scripts/changelog.ts:125-131`). `prependRelease` puts the section above the
   existing ones so the site never sorts (`scripts/changelog.ts:186-197`).
5. `parseChangelog` reads the same file back. The only line it matches is
   `/^## (\d+\.\d+\.\d+) - (\d{4}-\d{2}-\d{2})\s*$/` (`scripts/changelog.ts:38`);
   everything to the next heading is `body`. The parsed shape is
   `ReleaseSection { version, date, body }` (`scripts/changelog.ts:20-26`).
6. `internal/docs/scripts/generate.ts:360-372` imports that parser across the
   repo boundary (`generate.ts:20`) and maps each section to a `ReleaseNote`:
   `anchor = slugify(version)` gives `2-0-1`, `html = render(body, '#/releases')`
   runs the same markdown pipeline every guide uses, and every heading id in the
   result is prefixed with `${anchor}-` so 35 "Features" headings do not collide.
   `render` is `renderDoc` (`internal/docs/scripts/content.ts:172`), which is
   `Bun.markdown.html(markdown)` plus `highlightFences`, heading ids from
   `slugify`, and `rewriteHref` over every anchor
   (`internal/docs/scripts/content.ts:181-201`).
7. `ReleaseNote` in full (`internal/docs/scripts/extract/model.ts:132-143`):

   ```ts
   interface ReleaseNote {
     readonly version: string;   // '2.0.1'
     readonly date: string;      // 'YYYY-MM-DD'
     readonly anchor: string;    // '2-0-1', also the prefix on every heading id
     readonly html: string;      // rendered body, no heading line
   }
   ```

8. `writeFileSync(join(OUT_DIR, 'releases.json'), ...)`
   (`generate.ts:372`). It is not in `index.json`, and
   `internal/docs/src/data.ts:66-76` says why: largest generated file, no other
   route reads a byte of it. `RELEASE_BODIES` is a one-key table
   (`data.ts:71-73`), `loadReleases()` goes through the shared `load` helper
   (`data.ts:75`), and `loaded` caches the parse per key (`data.ts:41`), so the
   index page and a sub-page share one fetch and one parse.
9. `Releases` calls `useChunk(loadReleases, 'releases')`
   (`internal/docs/src/pages/Releases.tsx:28`, `chunk.ts:14`) and maps every note
   to a `Card` (`Releases.tsx:53-83`): the version as an `Anchor` to
   `#/releases?h=${release.anchor}` (`Releases.tsx:58`), `formatDate(release.date)`
   (`Releases.tsx:16-25`), an npm `Badge` hardcoded to
   `@dunx/core/v/<version>` (`Releases.tsx:73`), and `<Prose html={release.html} />`
   (`Releases.tsx:81`).

Measured on this checkout after a clean `bun run docs:build` (3.5 s wall, 724 ms
of it Vite):

| Artifact                                     | Raw       | Gzip      |
| -------------------------------------------- | --------- | --------- |
| `internal/docs/src/generated/releases.json`  | 40,520 B  | 11,236 B  |
| `dist/assets/releases-BeHmC4RT.js`           | 41,430 B  | 11.01 kB  |
| `internal/docs/src/generated/index.json`     | 52,378 B  | -         |
| `dist/assets/index-C9mMkhLb.js` (entry)      | 964.94 kB | 274.45 kB |

35 releases, `0.1.1` through `2.0.1`. Largest single note 14,597 bytes of JSON,
average 1,157. `site.test.tsx:99` caps `index.json` at 120,000 characters.

`git status --porcelain` was empty before and after the build:
`internal/docs/src/generated/` and `internal/docs/public/badges/` are gitignored
and `dist` is ignored globally, so `docs:build` writes nothing tracked.

Deployment: `vite.config.ts:20` sets `base: process.env['DOCS_BASE'] ?? '/dunx/'`,
`ci.yml:130-138` builds the site after the release step and uploads
`internal/docs/dist`, and the `pages` job deploys it (`ci.yml:142-159`). Routing
is hash-based because GitHub Pages has no SPA fallback
(`internal/docs/README.md:224`), so every sub-page URL is served by the one
`index.html` and resolved client-side.

`useScrollTo` depends on `[route.kind, route.slug, anchor]` (`router.ts:129`) and
scrolls to the top when `anchor === null` (`router.ts:97-100`), so index to
sub-page opens at the top. A `?h=` on a sub-page works unchanged, because the
generator prefixed every heading id with the version.

## Route and page design

**Route: `#/releases/2.0.1`.** `?v=2.0.1` would need a new query read in
`parseRoute` and `href` cannot express it (`router.ts:42`), while the path form
already parses and already matches `#/guide/<slug>` and `#/api/<dir>`.

**Unknown version: the existing `NotFound` panel**, matching `Guide.tsx:59`
(`<NotFound what={\`guide "${slug}"\`} />`). Not a redirect to the index: a
reader arriving from a GitHub note needs to see which version was asked for, and
a stale Pages deploy that predates the version renders this panel rather than a
404. The list is a chunk, so the skeleton must come first and `NotFound` only
after the chunk has landed.

**`v`-prefixed tags.** `ReleaseNote.version` is bare, and `site.test.tsx:397`
asserts `/^\d+\.\d+\.\d+$/`. A git tag would be `v2.0.1`. Strip one leading `v`
before lookup so both `#/releases/2.0.1` and `#/releases/v2.0.1` land.

**The index keeps full bodies.** The owner did not ask for it to change, every
existing link points at it (`App.tsx:169`, `App.tsx:211`, `Search.tsx:26`), and
the duplication costs zero bytes because both pages read the same cached chunk
(`data.ts:41`). One link changes: the version heading points at the sub-page, and
`id={release.anchor}` stays so bookmarked `?h=` links still scroll.

Real TSX, appended to `internal/docs/src/pages/Releases.tsx` so `formatDate`,
`DATE` and the npm badge shape stay declared once:

```tsx
/** A git tag is `v2.0.1`; `ReleaseNote.version` is `2.0.1`. Both must land. */
const stripTag = (slug: string): string => slug.replace(/^v/, '');

export const Release = ({ slug }: { slug: string }): React.JSX.Element => {
  const releases = useChunk(loadReleases, 'releases');
  const version = stripTag(slug);

  if (releases === undefined) {
    return (
      <Container size="md" py="xl">
        <Skeleton height={320} radius="md" />
      </Container>
    );
  }

  const at = releases.findIndex((release) => release.version === version);
  const release = releases[at];
  if (!release) return <NotFound what={`release "${slug}"`} />;

  const newer = releases[at - 1];
  const older = releases[at + 1];

  return (
    <Container size="md" py="xl">
      <Stack gap="lg">
        <Anchor href={href(RouteKind.Releases)} size="sm" c="dimmed">
          All releases
        </Anchor>

        <Group justify="space-between" align="center">
          <Title order={1}>{release.version}</Title>
          <Text size="sm" c="dimmed">
            {formatDate(release.date)}
          </Text>
        </Group>

        <Group gap="xs">
          {site.packages.map((pkg) => (
            <Badge
              key={pkg.dir}
              variant="default"
              size="sm"
              component="a"
              href={npmUrl(pkg.name, release.version)}
              target="_blank"
              style={{ cursor: 'pointer' }}
            >
              {pkg.name}
            </Badge>
          ))}
        </Group>

        <Card withBorder radius="md" padding="lg">
          <Prose html={release.html} />
        </Card>

        <Group justify="space-between">
          {older ? (
            <Anchor href={href(RouteKind.Releases, older.version)} size="sm">
              Previous: {older.version}
            </Anchor>
          ) : (
            <span />
          )}
          {newer ? (
            <Anchor href={href(RouteKind.Releases, newer.version)} size="sm">
              Next: {newer.version}
            </Anchor>
          ) : (
            <span />
          )}
        </Group>
      </Stack>
    </Container>
  );
};
```

`noUncheckedIndexedAccess` makes all three index reads `ReleaseNote | undefined`,
so `findIndex` returning `-1` is caught by `!release` with no extra branch. Ten
npm badges, one per package in `site.packages` (`data.ts:24`), because every
package ships at the same version (`version.ts:349`).

**No git compare link.** `git tag -l` returns 0 tags, so
`/compare/v2.0.0...v2.0.1` would 404. The body already links every commit
individually (`changelog.ts:129`).

**What should not go in `@dunx/ui`:** `formatDate`, `stripTag`, `npmUrl`, the
release card and the prev/next pair. Only `internal/docs` renders a release.
`internal/openapi-ui` and `internal/dashboard-ui` are inlined byte-for-byte into
a page a backend serves, so anything added there is paid for twice
(`internal/ui/README.md:52-56`), and neither has a changelog. What is reused:
`Prose` (`internal/ui/src/index.ts:41`, already imported at `Releases.tsx:12`),
`NotFound` (`pages/NotFound.tsx:4`), `useChunk` (`chunk.ts:14`), `loadReleases`
(`data.ts:75`), `href`/`RouteKind` (`router.ts:42`, `router.ts:3`) and Mantine
components the entry chunk already carries.

## Files to change

**EDIT `internal/docs/src/router.ts`** - add the one npm URL builder, next to
`href` and `symbolHref` which it sits beside in kind:

```ts
export const npmUrl = (name: string, version?: string): string =>
  `https://www.npmjs.com/package/${encodeURIComponent(name)}${version ? `/v/${version}` : ''}`;
```

Reason: Rule 2. `npmUrl` is declared privately at `pages/Home.tsx:29` and the
versioned form is hardcoded at `pages/Releases.tsx:73`. Three copies would exist
after this change. `router.ts` is already imported by both files.
`encodeURIComponent` is kept so `site.test.tsx:283-285`, which filters links by
`https://www.npmjs.com/package/` prefix, keeps counting the same ten.

**EDIT `internal/docs/src/pages/Home.tsx`** - delete the local `npmUrl` at
line 29, import it from `../router` (the file already imports `href, RouteKind`
from there at line 26). Reason: the deleted half of the Rule 2 move.

**EDIT `internal/docs/src/pages/Releases.tsx`** - three changes:
- the version `Anchor` at line 58 points at
  `href(RouteKind.Releases, release.version)` instead of
  `#/releases?h=${release.anchor}`; the `id={release.anchor}` at line 56 stays.
- the npm `Badge` at line 73 uses `npmUrl('@dunx/core', release.version)`.
- append `stripTag` and the `Release` component above. Adds ~75 lines, taking
  the file from 88 to ~165. Reason: `formatDate` and `DATE` (lines 16-25) are
  declared here and a separate `ReleasePage.tsx` would duplicate them.

**EDIT `internal/docs/src/App.tsx`** - line 237-238 becomes:

```tsx
    case RouteKind.Releases:
      return route.slug ? <Release slug={route.slug} /> : <Releases />;
```

and line 26 imports both. Reason: the slug is parsed already and discarded.

**EDIT `internal/docs/README.md`** - one row in the route table around line 63
and the `pages/` line at 221. Reason: the file documents every route and the
generated-file layout; it is `Mode.Exempt` in `no-slop.test.ts` but subject to
`no-em-dash.test.ts`.

Not changed, and worth stating: `internal/docs/src/router.ts` needs no parser
change, `internal/docs/scripts/generate.ts` needs none, `data.ts` needs none
(one chunk, already cached), `chunks.ts` is untouched, `Search.tsx` keeps its
single Releases action (35 more spotlight entries would bury the guides), and
`scripts/changelog.ts` and `scripts/version.ts` are untouched.

## Tests to change

| Test file                                    | Affected | How                                                                                                                                                                                                                 |
| -------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `internal/docs/src/site.test.tsx`            | yes      | 425 lines against a 500-line error cap. Move `describe('the release history')` (lines 386-425) and the navigation test at 368-383 into a new file, dropping `loadReleases` from the import at line 12. Leaves ~370.   |
| `internal/docs/src/releases.test.tsx` (NEW)  | new      | The two moved blocks plus: the sub-page renders the version and body; `#/releases/v2.0.1` resolves the same as `#/releases/2.0.1`; `#/releases/9.9.9` renders the Not found heading; prev/next resolve to real versions. |
| `internal/docs/src/links.test.tsx`           | optional | `SLUGLESS` at lines 12-17 holds `RouteKind.Releases`, so `#/releases/<anything>` passes unchecked at line 86. Nothing fails today: release bodies carry 174 hrefs, 0 internal, and no guide or README links a release. |
| `internal/docs/src/symbol-anchor.test.tsx`   | no       | Drives `useScrollTo` for `#/api/<dir>?h=symbol-*` only. The sub-page adds no symbol anchor.                                                                                                                          |
| `internal/docs/src/published-voice.test.ts`  | no       | Scans `generated/guides/*.json` only (line 13). Releases are not a guide.                                                                                                                                            |
| `scripts/no-em-dash.test.ts`                 | yes      | Scans every tracked and untracked file. The new TSX and the README edit must carry no `\u2014` or `\u2013`.                                                                                                          |
| `scripts/no-slop.test.ts`                    | no       | `[/^internal\//, Mode.Exempt]`. Both edited docs files are under `internal/`.                                                                                                                                        |

The optional `links.test.tsx` change, if taken, is the registration point the
new route shape needs: build a `Set` of versions from `await loadReleases()`,
drop `RouteKind.Releases` from `SLUGLESS`, and accept
`kind === 'releases' && (slug === '' || versions.has(slug))`. Eight lines. It
catches a future guide or README that cites a version that was never released.

Baseline before any of this: 83 pass, 0 fail, 1,172 expect calls, 8 files,
16.48 s (`bun run --filter '@dunx/docs' test`).

## The GitHub release link

Base path is `/dunx/` (`vite.config.ts:20`), deployed to GitHub Pages
(`ci.yml:130-159`, `internal/docs/README.md:4`). The exact absolute URL for the
`2.0.1` release note:

```
https://petarzarkov.github.io/dunx/#/releases/2.0.1
```

The one-line addition to a release note:

```
Full notes with every commit: https://petarzarkov.github.io/dunx/#/releases/2.0.1
```

**Today it is written by hand.** CI creates no GitHub release and no tag, so the
note itself only exists if the owner drafts one on github.com. Verified:
`gh release`, `git tag`, `createRelease`, `releases/tag` and `refs/tags` appear
nowhere in the repo, and `git tag -l` is empty.

**Minimal automation, if the owner wants it.** Four pieces, all in the publish
path:

1. `writeChangelog` (`scripts/version.ts:160-191`) already has the rendered
   section in hand at line 174 and returns only the path. Return the section
   text alongside it.
2. After `pushVersionCommit` (`scripts/version.ts:411-414`), run
   `gh release create v<version> --title <version> --notes <section + docs link>`.
   `gh` is preinstalled on `ubuntu-latest`, and `gh release create` creates the
   tag from `HEAD` when it does not exist.
3. `contents: write` is already granted (`ci.yml:15`), so `GITHUB_TOKEN` is
   enough. No new secret.
4. Guard it with `isDryRun` the way every other write in that file is.

Flagged as a separate decision the owner must approve. It touches the publish
path, which CLAUDE.md routes through `/release`, and it introduces git tags to a
repository that has none. The docs sub-page works without any of it.

## Risks and open spikes

- **A stale Pages deploy.** `ci.yml:119-132` publishes to npm, then builds the
  docs, then deploys. The release commit is `[skip ci]`
  (`scripts/version.ts:209`), so a failed Pages deploy is not retried until the
  next push and a note linking the new version shows the Not found panel. Hash
  routing means it is never an HTTP 404, which is why the panel beats a redirect.
- **`links.test.tsx` currently cannot catch a bad version link.** Stated above.
  Low severity, since nothing generates such a link.
- **`site.test.tsx` is 35 lines from the `max-lines` error.** Adding the new
  tests there without moving anything out would put it at ~465 and leave the next
  addition failing `lint:check`. That is why the split is in the plan rather than
  optional.
- **`?h=` on a sub-page.** Untested. Every heading id in the body is prefixed
  with the version (`generate.ts:368`) and `useScrollTo` looks up by id with no
  route awareness, so one assertion in the new test file covers it.
- **No spike needed.** Nothing depends on unverified Bun or tsc behaviour. The
  one uncertain number is the added bundle size, which a rebuild measures.

## Cost

**Files:** 5 edited (`router.ts`, `pages/Home.tsx`, `pages/Releases.tsx`,
`App.tsx`, `internal/docs/README.md`), 1 new test file, 2 test files edited
(`site.test.tsx` loses ~55 lines, `links.test.tsx` gains ~8 if taken).

**LOC:** ~+80 source (75 of them the `Release` component), -2 source
(`Home.tsx`'s `npmUrl`), ~+60 test net after the move.

**Added bundle bytes:** the page compiles into the entry chunk, since `App.tsx`
imports pages statically and only the `?raw` JSON is dynamic. ~75 lines of TSX
is roughly +2.5 kB raw, +0.8 kB gzip on an entry chunk of 964.94 kB raw /
274.45 kB gzip, so +0.3% gzip. No new Mantine component is pulled in: `Anchor`,
`Badge`, `Card`, `Container`, `Group`, `Skeleton`, `Stack`, `Text` and `Title`
are all already in `Releases.tsx:1-11`. `releases.json` stays at 40,520 bytes /
11,236 gzip, because the sub-page reads the same chunk the index does and
`data.ts:41` caches the parse. `index.json` does not grow, so the 120,000
character cap at `site.test.tsx:99` is untouched at 52,378.

**Ordering:** unaffected. `gen:cov` writes `coverage.json` and the badges and
never touches `releases.json`. `docs:build` is `generate && vite build` with no
new generated file to order. `ci.yml` step order stays as it is, with the docs
build after the release step so the new version's page is in the same deploy.
The docs suite grows from 83 tests to ~87.
