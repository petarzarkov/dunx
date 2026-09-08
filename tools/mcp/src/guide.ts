import type { ResourceDefinition } from './protocol.js';

/** The scheme the guide chapters are addressed by, as MCP resources and in links. */
export const GUIDE_SCHEME = 'dunx://guide/';

export interface GuideDoc {
  /** The file's basename without `.md`, e.g. `06-validation`. Also its resource id. */
  readonly slug: string;
  /** The `#` heading. */
  readonly title: string;
  /** The first paragraph, which is what the index shows. */
  readonly summary: string;
  /** The `##` headings, in order. Enough to route a question without the body. */
  readonly sections: readonly string[];
  readonly body: string;
}

export interface GuideEntry {
  readonly slug: string;
  readonly title: string;
  readonly summary: string;
  readonly sections: readonly string[];
  readonly uri: string;
}

export interface GuideHit {
  readonly slug: string;
  readonly line: number;
  readonly text: string;
}

/** Long enough to answer, short enough that a search is not a whole chapter. */
const MAX_HITS = 40;
/**
 * Per chapter, so the overall cap cannot be spent inside `01-introduction` before
 * the search reaches the chapter that answers the question. A flat cap did exactly
 * that for any common word.
 */
const MAX_HITS_PER_DOC = 5;
const MAX_HIT_LENGTH = 200;

export interface GuideSearch {
  readonly hits: readonly GuideHit[];
  /** Hits found beyond the ones returned. Zero means the list is everything. */
  readonly omitted: number;
}

/**
 * The written guide, bundled into this package from `docs/guide/`.
 *
 * It is here rather than fetched because the question it answers is asked before
 * there is an app to read, often before there is a network policy that allows
 * reaching one. A published copy also cannot disagree with the version of the
 * framework that shipped it.
 */
export class Guide {
  constructor(private readonly docs: readonly GuideDoc[]) {}

  private entry(doc: GuideDoc): GuideEntry {
    return {
      slug: doc.slug,
      title: doc.title,
      summary: doc.summary,
      sections: doc.sections,
      uri: `${GUIDE_SCHEME}${doc.slug}`,
    };
  }

  /** Every chapter without its body: the cheap answer to "what is documented". */
  index(): readonly GuideEntry[] {
    return this.docs.map((doc) => this.entry(doc));
  }

  /**
   * Slug and title only. `index()` costs 12 KB, which is a lot to spend inside
   * `dunx_start` on a map whose whole job is to say which chapter to ask for next.
   */
  titles(): readonly { readonly slug: string; readonly title: string }[] {
    return this.docs.map(({ slug, title }) => ({ slug, title }));
  }

  /**
   * Exact slug first, then the single chapter a substring matches. A caller that
   * has read the index passes a slug; one that has not passes `validation`, and
   * both land on the same chapter.
   *
   * A substring matching several is `undefined` rather than the first of them:
   * `docs/guide/` holds both `22-metrics` and `22-upgrading`, so `topic: "22"`
   * used to spend a whole chapter body on a coin flip. {@link candidates} is what
   * the caller is given instead.
   */
  chapter(topic: string): GuideDoc | undefined {
    const wanted = topic.toLowerCase().trim();
    if (wanted === '') return undefined;

    const exact = this.docs.find((doc) => doc.slug.toLowerCase() === wanted);
    if (exact !== undefined) return exact;

    const matches = this.docs.filter(
      (doc) =>
        doc.slug.toLowerCase().includes(wanted) ||
        doc.title.toLowerCase().includes(wanted),
    );
    return matches.length === 1 ? matches[0] : undefined;
  }

  /** Every chapter whose slug or title matches, so an ambiguous topic is nameable. */
  candidates(topic: string): readonly string[] {
    const wanted = topic.toLowerCase().trim();
    if (wanted === '') return [];
    return this.docs
      .filter(
        (doc) =>
          doc.slug.toLowerCase().includes(wanted) ||
          doc.title.toLowerCase().includes(wanted),
      )
      .map((doc) => doc.slug);
  }

  /**
   * Matching lines rather than matching chapters. A chapter is 30 KB and a question
   * is usually one paragraph, so the hit plus its chapter slug is what lets a
   * caller decide whether to spend the tokens on `topic`.
   */
  search(query: string, limit = MAX_HITS): GuideSearch {
    const needle = query.toLowerCase();
    const hits: GuideHit[] = [];
    let omitted = 0;

    for (const doc of this.docs) {
      let taken = 0;
      const lines = doc.body.split('\n');
      for (const [index, line] of lines.entries()) {
        if (!line.toLowerCase().includes(needle)) continue;
        if (taken >= MAX_HITS_PER_DOC || hits.length >= limit) {
          omitted += 1;
          continue;
        }
        hits.push({
          slug: doc.slug,
          line: index + 1,
          text: line.trim().slice(0, MAX_HIT_LENGTH),
        });
        taken += 1;
      }
    }

    return { hits, omitted };
  }

  /**
   * The same chapters as MCP resources, so a client that attaches documents rather
   * than calling tools reaches them too. The body is the markdown as written, with
   * chapter links rewritten to `dunx://guide/`, so a client following one stays in
   * the corpus instead of resolving a repo-relative path it does not have.
   */
  resources(): readonly ResourceDefinition[] {
    return this.docs.map((doc) => ({
      uri: `${GUIDE_SCHEME}${doc.slug}`,
      name: doc.title,
      description: doc.summary,
      mimeType: 'text/markdown',
      read: () => doc.body,
    }));
  }
}
