import { MantineProvider } from '@mantine/core';
import { fireEvent, render, waitFor } from '@testing-library/react';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from 'bun:test';
import { startupRows, throughputRows } from './bench';
import { StartupChart, ThroughputChart } from './components/BenchChart';
import { bench } from './data';

/**
 * The benchmark charts are `@mantine/charts` `BarChart`s with
 * `orientation="vertical"`, and that combination has a trap: Mantine renders its
 * Y axes as `yAxisId="left"` and `yAxisId="right"`, while recharts' `Tooltip`
 * defaults to `axisId: 0`. In a vertical layout the tooltip axis *is* the Y axis,
 * so the default matched no axis, recharts fell back to an implicit two-tick
 * numeric one, and every hover reported index 0 - the top bar - with a cursor
 * rectangle the height of the whole plot. `tooltipProps={{ axisId: 'left' }}` in
 * BenchChart is what points it back at the real category axis.
 *
 * happy-dom does no layout, so recharts sees a 0x0 chart and renders nothing.
 * `layout()` below supplies just enough of one: a fixed size for the chart
 * wrapper, and a plausible text metric for everything else, because recharts
 * measures tick labels to decide how many it can fit and treats an
 * unmeasurable label as one that overlaps every other.
 */
const WIDTH = 958;
const HEIGHT = 544;

/** The observer stub never disconnects; the DOM is thrown away after each test. */
const noop = (): void => undefined;

const isWrapper = (el: Element): boolean =>
  el.classList?.contains('recharts-wrapper') ?? false;

const textWidth = (el: Element): number => (el.textContent?.length ?? 0) * 6;

const original = {
  rect: Object.getOwnPropertyDescriptor(
    globalThis.Element.prototype,
    'getBoundingClientRect',
  ),
  width: Object.getOwnPropertyDescriptor(
    globalThis.HTMLElement.prototype,
    'offsetWidth',
  ),
  height: Object.getOwnPropertyDescriptor(
    globalThis.HTMLElement.prototype,
    'offsetHeight',
  ),
  observer: globalThis.ResizeObserver,
};

const restore = (): void => {
  const put = (
    target: object,
    key: string,
    descriptor: PropertyDescriptor | undefined,
  ): void => {
    if (descriptor) Object.defineProperty(target, key, descriptor);
    else delete (target as Record<string, unknown>)[key];
  };

  put(globalThis.Element.prototype, 'getBoundingClientRect', original.rect);
  put(globalThis.HTMLElement.prototype, 'offsetWidth', original.width);
  put(globalThis.HTMLElement.prototype, 'offsetHeight', original.height);
  globalThis.ResizeObserver = original.observer;
};

const layout = (): void => {
  const rect = function (this: Element): DOMRect {
    const w = isWrapper(this) ? WIDTH : textWidth(this);
    const h = isWrapper(this) ? HEIGHT : this.textContent ? 12 : 0;
    return {
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: w,
      bottom: h,
      width: w,
      height: h,
      toJSON: () => ({}),
    } as DOMRect;
  };
  Object.defineProperty(globalThis.Element.prototype, 'getBoundingClientRect', {
    configurable: true,
    value: rect,
  });
  Object.defineProperty(globalThis.HTMLElement.prototype, 'offsetWidth', {
    configurable: true,
    get(this: HTMLElement) {
      return isWrapper(this) ? WIDTH : textWidth(this);
    },
  });
  Object.defineProperty(globalThis.HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return isWrapper(this) ? HEIGHT : 12;
    },
  });
  globalThis.ResizeObserver = class {
    constructor(private readonly cb: ResizeObserverCallback) {}
    observe(target: Element): void {
      this.cb(
        [
          {
            target,
            contentRect: { width: WIDTH, height: HEIGHT } as DOMRectReadOnly,
          } as ResizeObserverEntry,
        ],
        this as unknown as ResizeObserver,
      );
    }
    unobserve = noop;
    disconnect = noop;
  } as unknown as typeof ResizeObserver;
};

/**
 * Waits for recharts to have drawn, rather than guessing how long it takes.
 *
 * This was a fixed 20 ms sleep, which passes on a quiet machine and does not on a
 * loaded CI runner: the whole file renders real charts through a faked
 * `ResizeObserver`, and one test timed out at the 5 s default while every
 * assertion in it was correct. A sleep asserts against a guess; this asserts
 * against the thing the tests then read.
 */
const draw = async (chart: React.JSX.Element): Promise<HTMLElement> => {
  const { container } = render(
    <MantineProvider defaultColorScheme="light">{chart}</MantineProvider>,
  );
  await waitFor(() => {
    expect(container.querySelector('.recharts-surface')).not.toBeNull();
  });
  return container;
};

interface Hover {
  readonly tooltip: string;
  readonly cursorHeight: number;
  readonly cursorTop: number;
}

const hover = async (container: HTMLElement, y: number): Promise<Hover> => {
  const wrapper = container.querySelector('.recharts-wrapper');
  if (!wrapper) throw new Error('the chart rendered no wrapper');
  fireEvent.mouseEnter(wrapper, { clientX: WIDTH / 2, clientY: y });
  fireEvent.mouseMove(wrapper, { clientX: WIDTH / 2, clientY: y });
  // The cursor is what every caller then measures, so it is what to wait for.
  await waitFor(() => {
    expect(container.querySelector('.recharts-tooltip-cursor')).not.toBeNull();
  });
  const cursor = container.querySelector('.recharts-tooltip-cursor');
  return {
    tooltip:
      container.querySelector('.recharts-tooltip-wrapper')?.textContent ?? '',
    cursorHeight: Number(cursor?.getAttribute('height') ?? NaN),
    cursorTop: Number(cursor?.getAttribute('y') ?? NaN),
  };
};

beforeAll(layout);

/**
 * Restored, because `bun test` shares one process across files: a permanent
 * `getBoundingClientRect` that reports a text metric for every element leaks into
 * every later suite. Left in place it broke `site.test.tsx`'s scroll assertion, and
 * only under the full `bun run test` - the docs suite alone still passed, which is
 * the worst kind of failure to leave behind.
 */
afterAll(restore);

afterEach(() => {
  document.body.innerHTML = '';
});

describe.if(bench !== null)('the benchmark charts', () => {
  const model = bench;

  test('draw one bar and one axis tick per subject', async () => {
    if (!model) return;
    const scenario = model.scenarios[0];
    if (!scenario) return;

    const container = await draw(
      <ThroughputChart rows={throughputRows(model, scenario.id)} />,
    );

    expect(container.querySelectorAll('.recharts-rectangle')).toHaveLength(
      model.subjects.length,
    );
    expect(
      container.querySelectorAll(
        '.recharts-yAxis .recharts-cartesian-axis-tick',
      ),
    ).toHaveLength(model.subjects.length);
  });

  /**
   * The grid reads the X value axis. Off the Y axis it landed on the implicit
   * one and produced lines spaced against nothing.
   */
  test('rule the grid off the value axis ticks', async () => {
    if (!model) return;
    const scenario = model.scenarios[0];
    if (!scenario) return;

    const container = await draw(
      <ThroughputChart rows={throughputRows(model, scenario.id)} />,
    );

    const at = (selector: string): number[] =>
      [...container.querySelectorAll(selector)].map((line) =>
        Number(line.getAttribute(selector.includes('vertical') ? 'x1' : 'y1')),
      );

    const vertical = at('.recharts-cartesian-grid-vertical line');
    expect(at('.recharts-cartesian-grid-horizontal line')).toHaveLength(0);
    expect(vertical.length).toBeGreaterThan(1);

    // Evenly spaced, because they sit on the numeric ticks of a linear scale.
    const gaps = vertical.slice(1).map((x, i) => x - (vertical[i] ?? 0));
    for (const gap of gaps) {
      expect(gap).toBeCloseTo(gaps[0] ?? 0, 3);
    }
  });

  /**
   * The regression itself. Hovering row N must report subject N, not subject 0.
   */
  test.each(model?.scenarios.map((scenario) => scenario.id) ?? [])(
    'name the hovered subject in %s',
    async (scenarioId) => {
      if (!model) return;
      const rows = throughputRows(model, scenarioId);
      const container = await draw(<ThroughputChart rows={rows} />);

      // Bands run from the top of the plot down; sample the middle of a few.
      const plotTop = 5;
      const plotHeight = HEIGHT - plotTop - 25;
      const band = plotHeight / rows.length;

      for (const index of [
        0,
        1,
        Math.floor(rows.length / 2),
        rows.length - 1,
      ]) {
        const row = rows[index];
        if (!row) continue;
        const { tooltip, cursorHeight } = await hover(
          container,
          plotTop + band * (index + 0.5),
        );
        expect(tooltip).toContain(row.label);
        // One row tall, not the whole plot - the broken cursor spanned everything.
        expect(cursorHeight).toBeLessThan(plotHeight / 2);
        expect(cursorHeight).toBeGreaterThan(0);
      }
    },
  );

  test('name the hovered subject in the cold start chart', async () => {
    if (!model) return;
    const rows = startupRows(model);
    const container = await draw(<StartupChart rows={rows} />);

    const plotTop = 5;
    const band = (HEIGHT - plotTop - 25) / rows.length;
    const last = rows[rows.length - 1];
    const first = rows[0];
    if (!first || !last) return;

    expect((await hover(container, plotTop + band * 0.5)).tooltip).toContain(
      first.label,
    );
    expect(
      (await hover(container, plotTop + band * (rows.length - 0.5))).tooltip,
    ).toContain(last.label);
  });

  /** The cursor must move with the pointer rather than sit on the first band. */
  test('move the cursor down as the pointer moves down', async () => {
    if (!model) return;
    const rows = startupRows(model);
    const container = await draw(<StartupChart rows={rows} />);

    const tops = [];
    for (const y of [40, 160, 280, 400]) {
      tops.push((await hover(container, y)).cursorTop);
    }

    for (let i = 1; i < tops.length; i += 1) {
      expect(tops[i]).toBeGreaterThan(tops[i - 1] ?? Number.POSITIVE_INFINITY);
    }
  });
});
