import { describe, expect, it } from 'bun:test';
import { Counter, Gauge } from './counters.js';

describe('Counter', () => {
  it('counts up by one, or by a step', () => {
    const counter = new Counter();
    expect(counter.value).toBe(0);
    counter.inc();
    counter.inc(4);
    expect(counter.value).toBe(5);
  });

  it('resets to zero', () => {
    const counter = new Counter();
    counter.inc(3);
    counter.reset();
    expect(counter.value).toBe(0);
  });
});

describe('Gauge', () => {
  it('goes down as well as up, and can be set outright', () => {
    const gauge = new Gauge();
    gauge.inc(10);
    gauge.dec(3);
    expect(gauge.value).toBe(7);
    gauge.set(2);
    expect(gauge.value).toBe(2);
  });

  it('may go negative, since a gauge tracks a level rather than a total', () => {
    const gauge = new Gauge();
    gauge.dec(2);
    expect(gauge.value).toBe(-2);
  });

  it('is a Counter, so anything taking one takes it', () => {
    const gauge = new Gauge();
    expect(gauge).toBeInstanceOf(Counter);
    gauge.reset();
    expect(gauge.value).toBe(0);
  });
});
