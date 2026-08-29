import { describe, expect, it } from 'bun:test';
import { parseOptions } from './cli.js';
import { bunCommand, profileFlags } from './subject-process.js';
import { subjects } from './subjects.js';

const bunSubject = subjects.find((s) => s.runtime === 'bun');

describe('--profile', () => {
  it('is off unless asked for', () => {
    expect(parseOptions([])?.profile).toBeUndefined();
    expect(profileFlags(undefined, '/tmp')).toEqual([]);
  });

  it('accepts cpu and heap', () => {
    expect(parseOptions(['--profile', 'cpu'])?.profile).toBe('cpu');
    expect(parseOptions(['--profile', 'heap'])?.profile).toBe('heap');
  });

  it('rejects anything else, rather than silently profiling nothing', () => {
    expect(() => parseOptions(['--profile', 'flame'])).toThrow(
      '--profile must be cpu or heap',
    );
  });

  it('asks for the markdown variant too', () => {
    // The markdown is the reason these are worth having in the harness: it is
    // readable in a terminal without a separate tool.
    expect(profileFlags('cpu', '/tmp/p')).toEqual([
      '--cpu-prof',
      '--cpu-prof-md',
      '--cpu-prof-dir=/tmp/p',
    ]);
    expect(profileFlags('heap', '/tmp/p')).toEqual([
      '--heap-prof',
      '--heap-prof-md',
      '--heap-prof-dir=/tmp/p',
    ]);
  });

  it('puts the flags before the entry, where bun reads them', () => {
    const command = bunCommand(bunSubject!, { kind: 'cpu', dir: '/tmp/p' });
    const entry = command.findIndex((part) => part.endsWith('.ts'));

    expect(command[0]).toBe('bun');
    expect(command.indexOf('--cpu-prof')).toBeLessThan(entry);
  });
});

describe('--no-orphans', () => {
  it('is always on for a Bun subject', () => {
    // The harness spawns a subject per subject and the queue worker forks a
    // child. A run killed part way used to leave both behind.
    expect(bunCommand(bunSubject!)).toContain('--no-orphans');
  });
});
