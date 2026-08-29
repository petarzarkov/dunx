import { describe, expect, test } from 'bun:test';
import { KeyDecoder, KeyName } from './keys.js';

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const names = (decoder: KeyDecoder, text: string): readonly string[] =>
  decoder.push(bytes(text)).map((key) => key.name);

const ESC = '\u001b';

describe('KeyDecoder', () => {
  test('decodes the arrow keys a terminal sends as three bytes', () => {
    const decoder = new KeyDecoder();

    expect(names(decoder, `${ESC}[A${ESC}[B${ESC}[C${ESC}[D`)).toEqual([
      KeyName.Up,
      KeyName.Down,
      KeyName.Right,
      KeyName.Left,
    ]);
  });

  test('decodes application-mode cursor keys too', () => {
    expect(names(new KeyDecoder(), `${ESC}OA${ESC}OB`)).toEqual([
      KeyName.Up,
      KeyName.Down,
    ]);
  });

  test('decodes home and end in both forms', () => {
    expect(
      names(new KeyDecoder(), `${ESC}[H${ESC}[F${ESC}[1~${ESC}[4~`),
    ).toEqual([KeyName.Home, KeyName.End, KeyName.Home, KeyName.End]);
  });

  test('holds an escape sequence split across two reads', () => {
    const decoder = new KeyDecoder();

    // The first read ends mid-sequence, so nothing is guessed at.
    expect(names(decoder, `${ESC}[`)).toEqual([]);
    expect(names(decoder, 'A')).toEqual([KeyName.Up]);
  });

  test('reads a lone escape byte as the Escape key', () => {
    expect(names(new KeyDecoder(), ESC)).toEqual([KeyName.Escape]);
  });

  test('names the control bytes the prompts bind', () => {
    const decoder = new KeyDecoder();

    expect(names(decoder, '\u0003\u0004\r\n\t \u0015\u007f\u0008')).toEqual([
      KeyName.Interrupt,
      KeyName.Interrupt,
      KeyName.Enter,
      KeyName.Enter,
      KeyName.Tab,
      KeyName.Space,
      KeyName.ClearLine,
      KeyName.Backspace,
      KeyName.Backspace,
    ]);
  });

  test('shift-tab is its own name, so it can move backwards', () => {
    expect(names(new KeyDecoder(), `${ESC}[Z`)).toEqual([KeyName.ShiftTab]);
  });

  test('printable characters carry what was typed', () => {
    const keys = new KeyDecoder().push(bytes('my-api'));

    expect(keys.map((key) => key.name)).toEqual(Array(6).fill(KeyName.Char));
    expect(keys.map((key) => key.char).join('')).toBe('my-api');
  });

  test('a code point split across two reads arrives whole', () => {
    const decoder = new KeyDecoder();
    const encoded = bytes('é');

    expect(decoder.push(encoded.slice(0, 1))).toEqual([]);
    expect(decoder.push(encoded.slice(1)).map((key) => key.char)).toEqual([
      'é',
    ]);
  });

  test('a surrogate pair stays one key, so backspace deletes one glyph', () => {
    const keys = new KeyDecoder().push(bytes('🐰'));

    expect(keys).toHaveLength(1);
    expect(keys[0]?.char).toBe('🐰');
  });

  test('an unbound sequence decodes to Unknown rather than its letters', () => {
    // Alt+a and a function key. Neither may leak an `a` into the selection.
    expect(names(new KeyDecoder(), `${ESC}a${ESC}[15~`)).toEqual([
      KeyName.Unknown,
      KeyName.Unknown,
    ]);
  });

  test('an unnamed control byte is Unknown', () => {
    expect(names(new KeyDecoder(), '\u0001')).toEqual([KeyName.Unknown]);
  });
});
