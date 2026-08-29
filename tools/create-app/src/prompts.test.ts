import { describe, expect, test } from 'bun:test';
import { CancelledError, PromptRunner, type Prompt } from './prompt.js';
import {
  ConfirmPrompt,
  SelectPrompt,
  TextPrompt,
  type SelectItem,
} from './prompts.js';
import { Style } from './style.js';
import { MemoryTty, Press } from './tty.fixture.js';

const CSI = '\u001b[';

/** Colours off, so a frame assertion is about the text and not the escapes. */
const style = new Style(false);

const ITEMS: readonly SelectItem[] = [
  { value: 'notes', label: 'notes', hint: 'CRUD routes' },
  { value: 'openapi', label: 'openapi', hint: 'the schema' },
  { value: 'database', label: 'database', hint: 'drizzle' },
];

/**
 * Runs a prompt the way the CLI does and answers it. `ask` opens the terminal
 * synchronously before its first await, so the keys can be sent straight after.
 */
const answer = async <T>(
  prompt: Prompt<T>,
  keys: readonly string[],
  tty = new MemoryTty(),
): Promise<{ value: T; tty: MemoryTty }> => {
  const runner = new PromptRunner(tty);
  const pending = runner.ask(prompt);
  tty.send(...keys);
  return { value: await pending, tty };
};

const type = (text: string): readonly string[] => Array.from(text);

describe('TextPrompt', () => {
  test('accepts the value it was given when Enter is the first key', async () => {
    const { value } = await answer(
      new TextPrompt(style, 'Directory', 'my-api'),
      [Press.enter],
    );

    expect(value).toBe('my-api');
  });

  test('types, backspaces and clears', async () => {
    const { value } = await answer(new TextPrompt(style, 'Directory', 'seed'), [
      Press.backspace,
      ...type('ing'),
      Press.clearLine,
      ...type('api'),
      Press.enter,
    ]);

    expect(value).toBe('api');
  });

  test('inserts at the cursor rather than at the end', async () => {
    const { value } = await answer(new TextPrompt(style, 'Directory', 'api'), [
      Press.home,
      ...type('my-'),
      Press.enter,
    ]);

    expect(value).toBe('my-api');
  });

  test('left and right move the cursor, and end returns to it', async () => {
    const { value } = await answer(
      new TextPrompt(style, 'Directory', 'my-pi'),
      [
        Press.left,
        Press.left,
        ...type('a'),
        Press.right,
        Press.end,
        ...type('!'),
        Press.enter,
      ],
    );

    expect(value).toBe('my-api!');
  });

  test('refuses a space, and says so instead of accepting one', () => {
    const prompt = new TextPrompt(style, 'Directory', 'my');
    const tty = new MemoryTty();
    void new PromptRunner(tty).ask(prompt);
    tty.send(Press.space);

    expect(tty.output()).toContain('A space is not usable here.');
    expect(prompt.done).toBe(false);
  });

  test('a validation failure keeps the prompt open', async () => {
    class Required extends TextPrompt {
      protected override validate(value: string): string | undefined {
        return value === '' ? 'Name a directory to write into.' : undefined;
      }
    }
    const prompt = new Required(style, 'Directory', '');
    const tty = new MemoryTty();
    const pending = new PromptRunner(tty).ask(prompt);

    tty.send(Press.enter);
    expect(prompt.done).toBe(false);
    expect(tty.output()).toContain('Name a directory to write into.');

    tty.send(...type('api'), Press.enter);
    expect(await pending).toBe('api');
  });

  test('the summary is what is left behind, not the frame', async () => {
    const { tty } = await answer(new TextPrompt(style, 'Directory', 'my-api'), [
      Press.enter,
    ]);

    // The frame is erased and one line replaces it, so the scrollback records
    // the answer rather than the widget.
    expect(tty.last()).toContain('Directory  my-api');
    expect(tty.last()).not.toContain('Ctrl+C to cancel');
  });
});

describe('ConfirmPrompt', () => {
  test('y and n answer outright', async () => {
    const yes = await answer(new ConfirmPrompt(style, 'Overwrite?', false), [
      'y',
    ]);
    const no = await answer(new ConfirmPrompt(style, 'Overwrite?', true), [
      'n',
    ]);

    expect(yes.value).toBe(true);
    expect(no.value).toBe(false);
  });

  test('Enter takes the highlighted option', async () => {
    const { value } = await answer(
      new ConfirmPrompt(style, 'Overwrite?', false),
      [Press.enter],
    );

    expect(value).toBe(false);
  });

  test('the arrows move the highlight', async () => {
    const { value } = await answer(
      new ConfirmPrompt(style, 'Overwrite?', false),
      [Press.right, Press.enter],
    );

    expect(value).toBe(true);
  });
});

describe('SelectPrompt', () => {
  test('space toggles the item under the cursor', async () => {
    const { value } = await answer(new SelectPrompt(style, 'Features', ITEMS), [
      Press.space,
      Press.down,
      Press.down,
      Press.space,
      Press.enter,
    ]);

    expect(value).toEqual(['notes', 'database']);
  });

  test('answers in list order whatever order they were toggled in', async () => {
    const { value } = await answer(new SelectPrompt(style, 'Features', ITEMS), [
      Press.end,
      Press.space,
      Press.home,
      Press.space,
      Press.enter,
    ]);

    expect(value).toEqual(['notes', 'database']);
  });

  test('a toggles everything and n clears it', async () => {
    const all = await answer(new SelectPrompt(style, 'Features', ITEMS), [
      'a',
      Press.enter,
    ]);
    const none = await answer(new SelectPrompt(style, 'Features', ITEMS), [
      'a',
      'n',
      Press.enter,
    ]);

    expect(all.value).toEqual(['notes', 'openapi', 'database']);
    expect(none.value).toEqual([]);
  });

  test('j and k move, and the cursor wraps at both ends', async () => {
    const { value } = await answer(new SelectPrompt(style, 'Features', ITEMS), [
      'k',
      Press.space,
      'j',
      Press.space,
      Press.enter,
    ]);

    expect(value).toEqual(['notes', 'database']);
  });

  test('shift-tab walks back up the list', async () => {
    const { value } = await answer(new SelectPrompt(style, 'Features', ITEMS), [
      Press.tab,
      Press.shiftTab,
      Press.space,
      Press.enter,
    ]);

    expect(value).toEqual(['notes']);
  });

  test('starts from the values it was given', async () => {
    const { value } = await answer(
      new SelectPrompt(style, 'Features', ITEMS, ['openapi']),
      [Press.enter],
    );

    expect(value).toEqual(['openapi']);
  });

  test('says what the empty selection means, rather than nothing', async () => {
    const { tty } = await answer(new SelectPrompt(style, 'Features', ITEMS), [
      Press.enter,
    ]);

    expect(tty.last()).toContain('none, the minimal template');
  });

  test('scrolls rather than overflowing a short terminal', () => {
    const many: SelectItem[] = Array.from({ length: 20 }, (_, at) => ({
      value: `f${at}`,
      label: `f${at}`,
      hint: '',
    }));
    const prompt = new SelectPrompt(style, 'Features', many);

    const first = prompt.frame(80, 12);
    expect(first.length).toBeLessThanOrEqual(12);
    expect(first.join('\n')).toContain('more');

    for (let step = 0; step < 19; step += 1)
      prompt.press({ name: 'down', char: '' });
    const last = prompt.frame(80, 12);

    expect(last.length).toBeLessThanOrEqual(12);
    expect(last.join('\n')).toContain('f19');
    expect(last.join('\n')).not.toContain(' f0 ');
  });

  test('the marker and the note say what a subclass pulls in', () => {
    class WithRequirements extends SelectPrompt {
      protected override implied(
        chosen: ReadonlySet<string>,
      ): ReadonlySet<string> {
        return chosen.has('notes') ? new Set(['database']) : new Set();
      }

      protected override notes(chosen: ReadonlySet<string>): readonly string[] {
        return chosen.has('notes') ? ['database comes along.'] : [];
      }
    }
    const prompt = new WithRequirements(style, 'Features', ITEMS);
    prompt.press({ name: 'space', char: '' });
    const frame = prompt.frame(80, 24).join('\n');

    expect(frame).toContain('◈ database');
    expect(frame).toContain('database comes along.');
    expect(frame).toContain('1 chosen, 1 pulled in');
  });
});

describe('PromptRunner', () => {
  test('repaints in place, so one frame replaces the last', async () => {
    const tty = new MemoryTty();
    await answer(
      new SelectPrompt(style, 'Features', ITEMS),
      [Press.down, Press.enter],
      tty,
    );
    const raw = tty.writes.join('');

    // Hidden while it draws, back on the way out, and every repaint walks the
    // cursor up over the frame it is replacing.
    expect(raw).toContain(`${CSI}?25l`);
    expect(raw).toContain(`${CSI}?25h`);
    expect(raw).toContain(`${CSI}0J`);
    expect(raw.split(CSI).filter((part) => /^\d+A/.test(part))).not.toBeEmpty();
  });

  test('opens the terminal once and closes it once', async () => {
    const { tty } = await answer(new TextPrompt(style, 'Directory', 'api'), [
      Press.enter,
    ]);

    expect(tty.opened).toBe(1);
    expect(tty.closed).toBe(1);
  });

  test('Ctrl+C cancels, restores the terminal and leaves no summary', async () => {
    const tty = new MemoryTty();
    const pending = new PromptRunner(tty).ask(
      new SelectPrompt(style, 'Features', ITEMS),
    );
    tty.send(Press.interrupt);

    expect(pending).rejects.toBeInstanceOf(CancelledError);
    await pending.catch(() => undefined);
    expect(tty.closed).toBe(1);
    expect(tty.writes.join('')).toContain(`${CSI}?25h`);
    expect(tty.last()).not.toContain('Features');
  });

  test('Escape cancels too', async () => {
    const tty = new MemoryTty();
    const pending = new PromptRunner(tty).ask(
      new TextPrompt(style, 'Directory', 'api'),
    );
    tty.send(Press.escape);

    expect(pending).rejects.toBeInstanceOf(CancelledError);
    await pending.catch(() => undefined);
  });

  test('keys behind the answer in one chunk are ignored', async () => {
    const prompt = new TextPrompt(style, 'Directory', 'api');
    const tty = new MemoryTty();
    const pending = new PromptRunner(tty).ask(prompt);
    // A paste, or a fast typist: the newline ends it and the rest is not the
    // next prompt's input.
    tty.send('\rxyz');

    expect(await pending).toBe('api');
  });

  test('clips a frame to the terminal width', async () => {
    const { tty } = await answer(
      new SelectPrompt(style, 'Features', [
        { value: 'notes', label: 'notes', hint: 'x'.repeat(200) },
      ]),
      [Press.enter],
      new MemoryTty(40, 24),
    );

    for (const line of tty.output().split('\n')) {
      expect(Bun.stringWidth(line)).toBeLessThanOrEqual(40);
    }
  });
});
