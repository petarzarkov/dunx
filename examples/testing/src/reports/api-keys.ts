/**
 * Stands in for a secret store - production would read a vault, this reads one
 * environment variable. A test binds a subclass with known keys instead, which is
 * smaller than any mocking API and needs no interface in front of it.
 */
export class ApiKeys {
  readonly #accepted = new Set(
    (Bun.env['API_KEYS'] ?? 'dev-key').split(',').filter(Boolean),
  );

  accepts(presented: string): boolean {
    return this.#accepted.has(presented);
  }
}
