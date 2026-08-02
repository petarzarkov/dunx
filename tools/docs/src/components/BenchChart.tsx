import { BarChart } from '@mantine/charts';
import { useComputedColorScheme } from '@mantine/core';
import { FOCUS, integer, type StartupRow, type ThroughputRow } from '../bench';

/**
 * The charts, from `@mantine/charts` - the same design system as the rest of the
 * site, so a bar here reads like a component rather than a bolted-on widget.
 *
 * They sit **above** the detail tables rather than replacing them. A chart shows
 * the shape of a result; it cannot show p50, p99 and a standard deviation without
 * becoming unreadable, and those are what tell you whether the shape is trustworthy.
 * So: chart for the comparison, table for the evidence.
 *
 * Colour marks `@dunx/http` and nothing else. Encoding rank in colour would make
 * the chart argue for a conclusion the numbers are supposed to deliver on their own.
 */
const focusColour = (dark: boolean): string =>
  dark ? 'var(--mantine-color-indigo-4)' : 'var(--mantine-color-indigo-6)';

const otherColour = (dark: boolean): string =>
  dark ? 'var(--mantine-color-dark-2)' : 'var(--mantine-color-gray-5)';

interface Datum {
  readonly subject: string;
  readonly value: number;
  readonly color: string;
}

const chartHeight = (count: number): number => Math.max(140, count * 34);

/** Horizontal, because subject labels are long and a rotated axis is unreadable. */
const Bars = ({
  data,
  unit,
}: {
  data: readonly Datum[];
  unit: string;
}): React.JSX.Element => (
  <BarChart
    h={chartHeight(data.length)}
    data={[...data]}
    dataKey="subject"
    orientation="vertical"
    gridAxis="x"
    withLegend={false}
    withTooltip
    tickLine="none"
    barProps={{ radius: [0, 3, 3, 0] }}
    series={[{ name: 'value', label: unit }]}
    valueFormatter={(value) => integer(value)}
    yAxisProps={{ width: 150, tick: { fontSize: 11 } }}
    xAxisProps={{ tick: { fontSize: 11 } }}
  />
);

export const ThroughputChart = ({
  rows,
}: {
  rows: readonly ThroughputRow[];
}): React.JSX.Element => {
  const dark = useComputedColorScheme('light') === 'dark';

  return (
    <Bars
      unit="req/s"
      data={rows.map((row) => ({
        subject: row.label,
        value: row.rps,
        color: row.id === FOCUS ? focusColour(dark) : otherColour(dark),
      }))}
    />
  );
};

export const StartupChart = ({
  rows,
}: {
  rows: readonly StartupRow[];
}): React.JSX.Element => {
  const dark = useComputedColorScheme('light') === 'dark';

  return (
    <Bars
      unit="ms"
      data={rows.map((row) => ({
        subject: row.label,
        value: row.medianMs,
        color: row.id === FOCUS ? focusColour(dark) : otherColour(dark),
      }))}
    />
  );
};
