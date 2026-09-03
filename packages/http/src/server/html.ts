/**
 * Serialise a value for a `<script type="application/json">` block.
 *
 * `<` is the only character that can end the data block early, and escaping it as
 * `\u003c` keeps the text valid JSON - the parser sees the same document either
 * way. `@dunx/dashboard` and `@dunx/openapi` both inline a model into a page they
 * serve, and both had a copy of this; if the escaping ever proves insufficient,
 * one fix should cover both pages.
 */
export const embedJson = (value: unknown): string =>
  JSON.stringify(value).replaceAll('<', '\\u003c');
