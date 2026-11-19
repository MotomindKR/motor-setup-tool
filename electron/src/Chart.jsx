import React, { useMemo } from "react";
import { CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@motomindkr/ui/components/chart";
import { Panel, Empty } from "./ui.jsx";

const maxPointsPerTrace = 2000;
const formatYAxisTick = new Intl.NumberFormat(undefined, { maximumSignificantDigits: 3 }).format;
function chartRows(series) {
  const rows = new Map();
  series.forEach((trace, index) => {
    const count = Math.min(trace.x.length, trace.y.length);
    const add = (i) => {
      const t = trace.x[i],
        value = trace.y[i];
      if (!Number.isFinite(t) || !Number.isFinite(value)) return;
      const row = rows.get(t) || { t };
      row[`trace${index}`] = value;
      rows.set(t, row);
    };
    if (count <= maxPointsPerTrace) {
      for (let i = 0; i < count; i++) add(i);
      return;
    }
    // Retain each bucket’s endpoints and extrema on their original timestamps.
    const width = Math.ceil((4 * count) / maxPointsPerTrace);
    for (let start = 0; start < count; start += width) {
      const end = Math.min(start + width, count);
      let low, high;
      for (let i = start; i < end; i++) {
        if (!Number.isFinite(trace.x[i]) || !Number.isFinite(trace.y[i])) continue;
        if (low === undefined || trace.y[i] < trace.y[low]) low = i;
        if (high === undefined || trace.y[i] > trace.y[high]) high = i;
      }
      add(start);
      if (low !== undefined) {
        add(low);
        add(high);
      }
      add(end - 1);
    }
  });
  return [...rows.values()].sort((a, b) => a.t - b.t);
}
export function Chart({ title, unit, series, compact = false }) {
  const data = useMemo(() => chartRows(series), [series]);
  const config = Object.fromEntries(
    series.map((trace, i) => [
      `trace${i}`,
      { label: trace.label, color: `var(${trace.color})` },
    ]),
  );
  const description = `${title} in ${unit} over time in seconds. ${series.map((trace) => trace.label).join(", ")}.`;
  return (
    <Panel
      className={`chart-card ${compact ? "chart-compact" : ""}`}
      title={
        <>
          {title}
          <span className="unit">{unit}</span>
        </>
      }
      size="md"
    >
      {data.length ? (
        <ChartContainer config={config} role="img" aria-label={description}>
          <LineChart
            data={data}
            accessibilityLayer
            margin={{ top: 8, right: 16, left: 0, bottom: 8 }}
          >
            <CartesianGrid vertical={false} />
            <XAxis
              dataKey="t"
              type="number"
              domain={["dataMin", "dataMax"]}
              axisLine={false}
              tickLine={false}
              minTickGap={32}
              tickFormatter={(value) => Number(value).toFixed(1)}
            />
            <YAxis
              axisLine={false}
              tickLine={false}
              width={54}
              domain={["auto", "auto"]}
              tickFormatter={formatYAxisTick}
            />
            <ChartTooltip
              content={
                <ChartTooltipContent
                  labelFormatter={(value) => `${Number(value).toFixed(3)} s`}
                />
              }
            />
            {series.map((trace, i) => (
              <Line
                key={i}
                dataKey={`trace${i}`}
                name={trace.label}
                stroke={`var(--color-trace${i})`}
                strokeWidth={1.7}
                dot={false}
                activeDot={{ r: 3 }}
                connectNulls
                isAnimationActive={false}
              />
            ))}
          </LineChart>
        </ChartContainer>
      ) : (
        <Empty compact title="No data to display" />
      )}
      <p className="chart-axis">Time (s)</p>
    </Panel>
  );
}

export function SingleTraceChart({ label, x, y, color = "--info-foreground", ...chart }) {
  const series = useMemo(() => [{ label, x, y, color }], [label, x, y, color]);
  return <Chart {...chart} series={series} />;
}
