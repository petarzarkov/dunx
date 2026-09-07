import { describe, expect, it } from 'bun:test';
import { $ } from 'bun';

/**
 * A literal control byte in a text file makes `grep` and `ripgrep` classify the
 * whole file as binary and skip it without reporting anything, which is how the
 * NUL in `packages/infra/src/queue/discover.ts` sat out every repo-wide search
 * until a byte-level sweep found it. NUL is the byte that causes that; the rest
 * of the C0 range is the same accident with a quieter symptom, so the ban is the
 * whole class.
 *
 * Tested by byte code rather than by a character class, so this file holds no
 * control character of its own and cannot match itself. `no-em-dash.test.ts`
 * needs a literal-free spelling for the same reason and solves it with escapes;
 * an escape for NUL inside a regex is easy to write and easy to mistake for the
 * byte it stands for, so this one compares numbers.
 */
const TAB = 0x09;
const LF = 0x0a;
const CR = 0x0d;
const SPACE = 0x20;
const DEL = 0x7f;

const isControl = (byte: number): boolean =>
  (byte < SPACE && byte !== TAB && byte !== LF && byte !== CR) || byte === DEL;

const BINARY = new Set(['.png', '.jpg', '.jpeg', '.gif', '.ico', '.webp']);

/** `file:line`, with the line derived from the newlines preceding the byte. */
const locate = (file: string, bytes: Uint8Array): string | undefined => {
  let line = 1;
  for (const byte of bytes) {
    if (isControl(byte)) return `${file}:${line}`;
    if (byte === LF) line++;
  }
  return undefined;
};

describe('no literal control characters', () => {
  it('across every tracked and untracked file', async () => {
    // `--others --exclude-standard` so a brand-new file counts before anyone
    // stages it, and `-z` because without it git quotes a pathname holding a
    // newline: splitting that on newlines yields `"a\nb.ts"`, which opens as
    // nothing, and the file escapes the scan. Fittingly, the delimiter that
    // fixes it is the byte this guard exists to ban.
    const listed =
      await $`git ls-files --cached --others --exclude-standard -z`.text();
    const offenders: string[] = [];

    for (const file of listed.split(String.fromCharCode(0)).filter(Boolean)) {
      if (BINARY.has(file.slice(file.lastIndexOf('.')))) continue;

      // A listed path can be gone by the time it is read, so ENOENT is skipped
      // rather than failed. Checking `exists()` first would not fix that, it
      // would only move the window. Every other read error propagates: a file
      // this guard cannot open must not count as clean.
      let bytes: Uint8Array;
      try {
        bytes = await Bun.file(file).bytes();
      } catch (error) {
        if ((error as { code?: string }).code === 'ENOENT') continue;
        throw error;
      }

      const found = locate(file, bytes);
      if (found !== undefined) offenders.push(found);
    }

    expect(offenders).toEqual([]);
  });
});
