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
  /**
   * The chapters the query's own words point at, best first.
   *
   * {@link Guide.search} matches literal text, so a question phrased as a
   * sentence - `validate a request body` - matches no line in any chapter and
   * used to answer `hits: []` with nothing to do next. This is the answer to
   * that: the same query scored word by word against every chapter's title,
   * section headings, summary and body.
   */
  readonly suggested: readonly string[];
}

/** Ranked chapters, so a sentence gets somewhere to go. */
const MAX_SUGGESTED = 5;

/**
 * Words too common to route on. Small on purpose: a longer list is a language
 * model of its own, and a token that survives into the scoring costs one
 * `includes` per chapter.
 */
const STOPWORDS: ReadonlySet<string> = new Set([
  'a',
  'all',
  'an',
  'and',
  'any',
  'are',
  'but',
  'can',
  'do',
  'does',
  'for',
  'from',
  'get',
  'has',
  'have',
  'how',
  'in',
  'into',
  'is',
  'it',
  'its',
  'me',
  'my',
  'no',
  'not',
  'of',
  'on',
  'one',
  'or',
  'that',
  'the',
  'their',
  'then',
  'this',
  'to',
  'use',
  'using',
  'what',
  'when',
  'where',
  'which',
  'why',
  'with',
  'you',
  'your',
]);

/**
 * A word's first five characters, which is the whole of the stemming here.
 *
 * `validate` and `Validation` share no substring in either direction, so matching
 * the words themselves put `06-validation` outside the top five for
 * `validate a request body` - the query this exists to answer. Five characters
 * makes that pair agree, along with `limiting`/`Limits`, `config`/`Configuration`
 * and `queue`/`Queues`, and it is one `slice` rather than a suffix table nobody
 * can predict the behaviour of.
 */
const stem = (word: string): string => word.slice(0, 5);

/** The query's own words: lowercase, at least two characters, not a stopword. */
const wordsOf = (query: string): readonly string[] => [
  ...new Set(
    query
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length > 1 && !STOPWORDS.has(word))
      .map(stem),
  ),
];

/**
 * Where a word was found decides what it is worth. A chapter titled `Validation`
 * is what `validate a request body` is asking for; the word appearing somewhere
 * in a 30 KB body is the weakest evidence there is, and every chapter mentioning
 * zod would otherwise tie with the one about it.
 */
const TITLE_WEIGHT = 8;
const SECTION_WEIGHT = 4;
const SUMMARY_WEIGHT = 3;
const BODY_WEIGHT = 1;

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
   * two chapters sharing a number - which `docs/guide/` had, as `22-metrics`
   * and `22-upgrading` - used to spend a whole chapter body on a coin flip.
   * {@link candidates} is what the caller is given instead, and the numbering is
   * no longer the only thing keeping it from happening.
   */
  chapter(topic: string): GuideDoc | undefined {
    const wanted = topic.toLowerCase().trim();
    if (wanted === '') return undefined;

    const exact = this.docs.find((doc) => doc.slug.toLowerCase() === wanted);
    if (exact !== undefined) return exact;

    // Through `candidates`, so the two cannot disagree about what matches.
    const matches = this.candidates(topic);
    return matches.length === 1
      ? this.docs.find((doc) => doc.slug === matches[0])
      : undefined;
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
   * Every chapter whose title, headings, summary or body carry the query's words,
   * most-matching first. Ties keep guide order, so the earlier chapter wins - a
   * reader with two equal answers wants the one that assumes less.
   */
  suggest(query: string, limit = MAX_SUGGESTED): readonly string[] {
    const words = wordsOf(query);
    if (words.length === 0) return [];

    const scored = this.docs.map((doc) => {
      const title = doc.title.toLowerCase();
      const sections = doc.sections.join(' ').toLowerCase();
      const summary = doc.summary.toLowerCase();
      const body = doc.body.toLowerCase();
      let score = 0;
      // A body-only chapter does not qualify at all. Every chapter mentions
      // `route` and `module` somewhere, so scoring bodies alone ranked
      // `01-introduction` and `04-modules` against any query at all: the tail was
      // guide order wearing a score. The body breaks ties between chapters that
      // already named the subject in a heading.
      let named = false;
      for (const word of words) {
        if (title.includes(word)) {
          score += TITLE_WEIGHT;
          named = true;
        }
        if (sections.includes(word)) {
          score += SECTION_WEIGHT;
          named = true;
        }
        if (summary.includes(word)) {
          score += SUMMARY_WEIGHT;
          named = true;
        }
        if (body.includes(word)) score += BODY_WEIGHT;
      }
      return { slug: doc.slug, score: named ? score : 0 };
    });

    return scored
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((entry) => entry.slug);
  }

  /**
   * Matching lines rather than matching chapters. A chapter is 30 KB and a question
   * is usually one paragraph, so the hit plus its chapter slug is what lets a
   * caller decide whether to spend the tokens on `topic`.
   *
   * Literal text, so {@link suggest} rides along in `suggested` for the query that
   * is a sentence rather than a term.
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

    return { hits, omitted, suggested: this.suggest(query) };
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
