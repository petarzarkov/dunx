import { describe, expect, it } from 'bun:test';
import { DashboardOptions, normalizeMount } from './options.js';

describe('normalizeMount', () => {
  it('gives one leading slash and no trailing one', () => {
    expect(normalizeMount('_dunx')).toBe('/_dunx');
    expect(normalizeMount('/_dunx/')).toBe('/_dunx');
    expect(normalizeMount('//admin//panel//')).toBe('/admin/panel');
  });

  it('refuses the root', () => {
    // The middleware claims every path under its mount, so `/` would answer every
    // request in the app rather than falling through.
    expect(() => normalizeMount('/')).toThrow(/cannot be "\/"/);
    expect(() => normalizeMount('')).toThrow(/cannot be "\/"/);
  });
});

describe('DashboardOptions', () => {
  it('mounts at /_dunx and polls every 5s', () => {
    const options = new DashboardOptions();
    expect(options.path).toBe('/_dunx');
    expect(options.pollMs).toBe(5000);
    expect(options.commands).toBe(true);
  });

  it('reveals no config value by default', () => {
    // The open question the design left, answered the safe way: a deny-list that
    // misses one key is worse than no config panel.
    const options = new DashboardOptions();
    expect(options.reveal('NODE_ENV', 'test')).toBe(false);
    expect(options.reveal('ANYTHING', 1)).toBe(false);
  });

  it('has no authorize function, which is the thing worth warning about', () => {
    expect(new DashboardOptions().authorize).toBeUndefined();
  });
});
