import React, { useMemo } from "react";
import { CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@motomindkr/ui/components/chart";
import { Panel, Empty } from "./ui.jsx";

// Keep each trace on its recorded timestamps, including independently sampled
// torque commands. Limit rendered SVG points without changing stored samples.
function chartRows(series) {
  const rows = new Map();
  series.forEach((trace, index) => {
    const count = Math.min(trace.x.length, trace.y.length);
    const stride = Math.max(1, Math.ceil(count / 2000));
    const add = (i) => {
      const t = trace.x[i],
        value = trace.y[i];
      if (!Number.isFinite(t) || !Number.isFinite(value)) return;
      const row = rows.get(t) || { t };
      row[`trace${index}`] = value;
      rows.set(t, row);
    };
    for (let i = 0; i < count; i += stride) add(i);
    if (count) add(count - 1);
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
              tickFormatter={(value) =>
                Number(value).toLocaleString(undefined, {
                  maximumSignificantDigits: 3,
                })
              }
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
