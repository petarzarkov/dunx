/**
 * Adds `field` to `Vary` unless it is already listed or `Vary` is `*`. The
 * common case, no `Vary` yet, is one `set` with nothing split.
 */
export const varyOn = (headers: Headers, field: string): void => {
  const existing = headers.get('vary');
  if (existing === null) {
    headers.set('vary', field);
    return;
  }
  if (existing.trim() === '*') return;
  const wanted = field.toLowerCase();
  const listed = existing
    .split(',')
    .some((entry) => entry.trim().toLowerCase() === wanted);
  if (!listed) headers.set('vary', `${existing}, ${field}`);
};
