/**
 * Groups an array of items by a key returned from the callback.
 */
export const groupBy = <T>(
  items: T[],
  keyFn: (item: T) => string,
): Record<string, T[]> => {
  const result: Record<string, T[]> = {};
  for (const item of items) {
    const key = keyFn(item);
    if (!result[key]) result[key] = [];
    result[key].push(item);
  }
  return result;
};

/**
 * Returns a new array with only unique elements, using an optional key function.
 */
export const unique = <T>(items: T[], keyFn?: (item: T) => unknown): T[] => {
  if (!keyFn) return [...new Set(items)];
  const seen = new Set<unknown>();
  return items.filter((item) => {
    const key = keyFn(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

/**
 * Chunks an array into smaller arrays of the given size.
 */
export const chunk = <T>(items: T[], size: number): T[][] => {
  if (size < 1) throw new RangeError('size must be at least 1');
  const result: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    result.push(items.slice(i, i + size));
  }
  return result;
};
