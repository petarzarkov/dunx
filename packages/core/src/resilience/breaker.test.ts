import { afterEach, describe, expect, it, setSystemTime } from 'bun:test';
import { AppError } from '../di/errors.js';
import {
  CircuitBreaker,
  CircuitOpenError,
  type CircuitState,
} from './breaker.js';

const T0 = new Date('2026-01-01T00:00:00Z');
const at = (ms: number) => setSystemTime(new Date(T0.getTime() + ms));

afterEach(() => {
  setSystemTime();
});

const boom = new Error('boom');

/** Opens a fresh breaker at `T0`, recording each transition. */
const opened = (threshold = 2, extra: { halfOpenProbes?: number } = {}) => {
  const moves: [CircuitState, CircuitState][] = [];
  at(0);
  const breaker = new CircuitBreaker({
    failureThreshold: threshold,
    openMs: 1_000,
    onStateChange: (to, from) => moves.push([to, from]),
    ...extra,
  });
  for (let i = 0; i < threshold; i += 1) {
    expect(breaker.admit()).toBeUndefined();
    breaker.failure(boom);
  }
  return { breaker, moves };
};

describe('CircuitBreaker', () => {
  it('opens on consecutive failures, and a success in between resets the count', () => {
    const breaker = new CircuitBreaker({ failureThreshold: 3 });
    breaker.failure(boom);
    breaker.failure(boom);
    breaker.success();
    breaker.failure(boom);
    breaker.failure(boom);
    expect(breaker.state).toBe('closed');
    breaker.failure(boom);
    expect(breaker.state).toBe('open');
  });

  it('rejects while open, then lets one probe through once openMs has passed', () => {
    const { breaker, moves } = opened();
    at(999);
    expect(breaker.admit()).toBeInstanceOf(CircuitOpenError);

    at(1_000);
    expect(breaker.admit()).toBeUndefined();
    expect(breaker.state).toBe('half-open');
    const second = breaker.admit();
    expect(second).toBeInstanceOf(CircuitOpenError);
    expect(second?.state).toBe('half-open');
    expect(second?.status).toBe(503);

    breaker.success();
    expect(breaker.state).toBe('closed');
    expect(moves).toEqual([
      ['open', 'closed'],
      ['half-open', 'open'],
      ['closed', 'half-open'],
    ]);
  });

  it('reopens on a failed probe, for a fresh openMs', () => {
    const { breaker } = opened();
    at(1_000);
    breaker.admit();
    at(1_500);
    breaker.failure(boom);
    expect(breaker.state).toBe('open');
    at(2_400);
    expect(breaker.admit()).toBeInstanceOf(CircuitOpenError);
    at(2_500);
    expect(breaker.admit()).toBeUndefined();
  });

  it('allows halfOpenProbes at once', () => {
    const { breaker } = opened(1, { halfOpenProbes: 2 });
    at(1_000);
    expect(breaker.admit()).toBeUndefined();
    expect(breaker.admit()).toBeUndefined();
    expect(breaker.admit()).toBeInstanceOf(CircuitOpenError);
  });

  /**
   * A caller hanging up says nothing about the dependency, and a probe it held
   * goes back, or the circuit would stay half-open and refuse everything.
   */
  it('ignores an abort by default, and frees the probe it held', () => {
    const abort = new Error('gone');
    abort.name = 'AbortError';
    const closed = new CircuitBreaker({ failureThreshold: 1 });
    closed.failure(abort);
    expect(closed.state).toBe('closed');

    const { breaker } = opened(1);
    at(1_000);
    breaker.admit();
    breaker.failure(abort);
    expect(breaker.state).toBe('half-open');
    expect(breaker.admit()).toBeUndefined();
  });

  it('counts a timeout, and only what isFailure accepts', () => {
    const timeout = new Error('late');
    timeout.name = 'TimeoutError';
    const byDefault = new CircuitBreaker({ failureThreshold: 1 });
    byDefault.failure(timeout);
    expect(byDefault.state).toBe('open');

    const narrowed = new CircuitBreaker({
      failureThreshold: 1,
      isFailure: (error) => error !== boom,
    });
    narrowed.failure(boom);
    expect(narrowed.state).toBe('closed');
  });

  it('does not extend openMs for an attempt landing while open', () => {
    const { breaker } = opened();
    at(900);
    breaker.failure(boom);
    at(1_000);
    expect(breaker.admit()).toBeUndefined();
  });

  it('refuses a threshold or probe count below 1', () => {
    expect(() => new CircuitBreaker({ failureThreshold: 0 })).toThrow(AppError);
    expect(() => new CircuitBreaker({ halfOpenProbes: 1.5 })).toThrow(
      'halfOpenProbes',
    );
  });
});
