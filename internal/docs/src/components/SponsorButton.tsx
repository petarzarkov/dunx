/**
 * The GitHub Sponsors button, embedded from GitHub's own endpoint.
 *
 * `loading="lazy"` so the iframe fetches only once it is scrolled near the
 * viewport. Both footers sit below the fold, so a page never pays for a
 * third-party request on load - and the browser suite, which asserts no console
 * error per route, never reaches it.
 */
export const SponsorButton = (): React.JSX.Element => (
  <iframe
    src="https://github.com/sponsors/petarzarkov/button"
    title="Sponsor petarzarkov"
    height={32}
    width={114}
    loading="lazy"
    referrerPolicy="no-referrer"
    style={{ border: 0, borderRadius: 6 }}
  />
);
