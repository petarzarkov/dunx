import samples from '../generated/samples.json?raw';

/**
 * A code sample, highlighted at generate time and looked up by id.
 *
 * The alternative was shipping shiki to the browser, which carries a TextMate
 * grammar per language and a full theme and would have cost more than the whole
 * current bundle. Every sample on this site is known when the site is built, so
 * none of that needs to reach a reader.
 *
 * `dangerouslySetInnerHTML` is safe here in the way the name is asking about: the
 * markup is shiki's own output over strings committed to this repo, generated in
 * the same build that renders it. Nothing user-supplied reaches it.
 */
const HTML = JSON.parse(samples) as Record<string, string>;

export const Highlighted = ({
  id,
  fallback,
}: {
  id: string;
  /** Rendered verbatim when the id is not in the map, so a typo shows the code. */
  fallback: string;
}): React.JSX.Element => {
  const html = HTML[id];
  if (html === undefined) {
    return (
      <pre className="win-body">
        <code>{fallback}</code>
      </pre>
    );
  }
  return <div dangerouslySetInnerHTML={{ __html: html }} />;
};
