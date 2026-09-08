import { describe, expect, it } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = join(import.meta.dir, 'render-review.ts');
const dir = mkdtempSync(join(tmpdir(), 'dunx-render-review-'));

let seq = 0;

/** Runs the script the way the workflow does, and hands back both its outputs. */
const render = async (
  result: string,
): Promise<{ code: number; verdict: string; body: string; stderr: string }> => {
  seq += 1;
  const execution = join(dir, `execution-${seq}.json`);
  const bodyOut = join(dir, `body-${seq}.md`);
  await Bun.write(execution, JSON.stringify({ type: 'result', result }));

  const proc = Bun.spawn(['bun', SCRIPT, execution, bodyOut], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [verdict, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const file = Bun.file(bodyOut);
  return {
    code,
    verdict: verdict.trim(),
    body: (await file.exists()) ? await file.text() : '',
    stderr,
  };
};

const finding = (over: Record<string, unknown> = {}) => ({
  file: 'tools/mcp/src/guide.ts',
  line: 42,
  summary: 'It does the wrong thing.',
  failure_scenario: 'A caller passes x and gets y.',
  ...over,
});

/**
 * The reviewer emits the skill's typed findings list, and the first review that
 * reached a pull request was that list as raw JSON in the body. Rendering is done
 * here rather than asked for in a prompt, because two prompts asking the model to
 * change its output were measured and ignored.
 */
describe('rendering a review', () => {
  it('turns a findings list into prose a person reads', async () => {
    const { code, verdict, body } = await render(
      JSON.stringify([finding(), finding({ file: 'a.ts', line: 1 })]),
    );
    expect(code).toBe(0);
    expect(verdict).toBe('comment');
    expect(body).toContain('Reviewed the diff. 2 findings.');
    expect(body).toContain('### `tools/mcp/src/guide.ts:42`');
    expect(body).toContain('**How it fails:** A caller passes x and gets y.');
    expect(body).not.toContain('"summary"');
  });

  it('counts one finding singular', async () => {
    const { body } = await render(JSON.stringify([finding()]));
    expect(body).toContain('1 finding.');
  });

  it('reads a fenced block, which is how the model actually writes it', async () => {
    const { verdict, body } = await render(
      `Here is what I found:\n\n\`\`\`json\n${JSON.stringify([finding()])}\n\`\`\`\n`,
    );
    expect(verdict).toBe('comment');
    expect(body).toContain('### `tools/mcp/src/guide.ts:42`');
  });

  /**
   * The review that prompted this file wrote two fenced blocks with a heading
   * between them. Reading only the first dropped a finding.
   */
  it('collects findings from every fenced block', async () => {
    const { body } = await render(
      `\`\`\`json\n${JSON.stringify([finding()])}\n\`\`\`\n\n## Findings\n\n` +
        `\`\`\`json\n${JSON.stringify([finding({ file: 'b.ts', line: 7 })])}\n\`\`\``,
    );
    expect(body).toContain('2 findings.');
    expect(body).toContain('### `b.ts:7`');
  });

  it('approves an empty findings list', async () => {
    const { code, verdict, body } = await render('[]');
    expect(code).toBe(0);
    expect(verdict).toBe('approve');
    expect(body).toContain('nothing worth changing');
  });

  it('passes prose through, taking the verdict from the sentinel', async () => {
    const { verdict, body } = await render(
      'Looks good to me.\n\nVERDICT: APPROVE\n',
    );
    expect(verdict).toBe('approve');
    expect(body.trim()).toBe('Looks good to me.');
    expect(body).not.toContain('VERDICT');
  });

  it('comments when prose carries no sentinel, rather than approving', async () => {
    const { verdict } = await render('Some notes, no verdict line.');
    expect(verdict).toBe('comment');
  });

  it('leaves a JSON array that is not findings alone', async () => {
    const { verdict, body } = await render('[1, 2, 3]');
    expect(verdict).toBe('comment');
    expect(body.trim()).toBe('[1, 2, 3]');
  });

  /** A green check over an empty review is the defect this whole job started with. */
  it('fails rather than posting an empty review', async () => {
    const { code, stderr } = await render('   ');
    expect(code).toBe(1);
    expect(stderr).toContain('no review');
  });

  it('reads the result out of a whole event stream', async () => {
    const execution = join(dir, 'stream.json');
    const bodyOut = join(dir, 'stream-body.md');
    await Bun.write(
      execution,
      JSON.stringify([
        { type: 'init' },
        { type: 'result', result: JSON.stringify([finding()]) },
      ]),
    );
    const proc = Bun.spawn(['bun', SCRIPT, execution, bodyOut], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(await proc.exited).toBe(0);
    expect(await Bun.file(bodyOut).text()).toContain('1 finding.');
  });
});
