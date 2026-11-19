import React from "react";
import {
  CheckCircle2,
  CircleAlert,
  Copy,
  FileChartColumn,
  FolderOpen,
  RefreshCw,
  Download,
  MoreHorizontal,
  Trash2,
} from "lucide-react";
import { Badge } from "@motomindkr/ui/components/badge";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@motomindkr/ui/components/dropdown-menu";
import {
  Item,
  ItemContent,
  ItemTitle,
  ItemDescription,
  ItemActions,
} from "@motomindkr/ui/components/item";
import {
  Panel,
  Button,
  Check,
  Empty,
  Segments,
  Metric,
  Disclosure,
} from "../ui.jsx";
import { Chart } from "../Chart.jsx";
import { numberText } from "../controller.mjs";
import { conciseNumber } from "../format.mjs";

function RunMenu({ directory, files = [], a, disabled, compact = false }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant={compact ? "ghost" : "outline"}
            size={compact ? "icon-sm" : "sm"}
            disabled={disabled}
            aria-label={compact ? "Run actions" : undefined}
          />
        }
      >
        {compact ? (
          <MoreHorizontal />
        ) : (
          <>
            <Download /> Download
          </>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={() => a.exportRun(directory)}>
          <Download /> Entire run (.zip)
        </DropdownMenuItem>
        {[
          ["training.csv", "Training recording (.csv)"],
          ["validation.csv", "Validation recording (.csv)"],
          ["calibration.json", "Calibration (.json)"],
        ]
          .filter(([file]) => files.includes(file))
          .map(([file, label]) => (
            <DropdownMenuItem
              key={file}
              onClick={() => a.exportRun(directory, file)}
            >
              <Download />
              {label}
            </DropdownMenuItem>
          ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          variant="destructive"
          onClick={() => a.deleteRun(directory)}
        >
          <Trash2 /> Delete run
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const axes = [
  { key: "velocity", label: "Velocity", unit: "rad/s" },
  { key: "position", label: "Position", unit: "rad" },
];
const traces = [
  { key: "measured", prefix: "measured", label: "Measured", color: "--foreground" },
  { key: "before", prefix: "pre", label: "Before", color: "--premium" },
  { key: "after", prefix: "post", label: "After", color: "--info-foreground" },
];

const MotionCharts = React.memo(function MotionCharts({ replay, visible, residual, reference }) {
  return axes.map(({ key, label, unit }) => {
    const measured = replay[`measured_${key}`];
    const offset = key === "position" ? reference : 0;
    const series = traces
      .filter(trace => visible[trace.key] && !(residual && trace.key === "measured"))
      .map(({ prefix, label, color }) => {
        let y = replay[`${prefix}_${key}`];
        if (residual) y = y.map((value, i) => value - measured[i]);
        else if (offset) y = y.map(value => value + offset);
        return { label, color, x: replay.t, y };
      });
    return (
      <Chart key={key} title={residual ? `${label} residual` : label} unit={unit} series={series} />
    );
  });
});

function Recording({ s, a, c }) {
  const r = s.report;
  const run = s.runs.find((item) => item.directory === s.directory);
  const motorId = r?.motor_id ?? run?.motorId;
  const folder = s.directory?.split(/[\\/]/).at(-1);
  const recordedAt =
    run?.timestamp ??
    Number(/^\d{13}(?=-|$)/.exec(folder || "")?.[0]);
  return (
    <div className="stack report">
      <div className="section-heading">
        <div>
          <h2>
            {r?.model || run?.model || folder} {motorId != null && <span className="muted">/ ID {motorId}</span>}
          </h2>
          <p className="report-path" title={s.directory}>
            {Number.isFinite(recordedAt)
              ? new Date(recordedAt).toLocaleString(undefined, {
                  dateStyle: "medium",
                  timeStyle: "short",
                })
              : folder}
          </p>
          <p className="recording-identity">
            Actuator UUID <code>{s.reportUuid || "Not recorded"}</code>
          </p>
        </div>
        <Badge variant={r?.accepted ? "success" : "warning"}>
          {r?.accepted ? <CheckCircle2 /> : <CircleAlert />}
          {r ? (r.accepted ? "Validated" : "Needs improvement") : "No report"}
        </Badge>
      </div>
      <div className="report-actions">
        <RunMenu
          directory={s.directory}
          files={s.reportFiles}
          a={a}
          disabled={c.busy}
        />
        <Button variant="outline" size="sm" onClick={a.showFolder}>
          <FolderOpen />
          Show folder
        </Button>
        <Button variant="ghost" size="sm" onClick={a.copyPath}>
          <Copy />
          Copy path
        </Button>
        <Button variant="ghost" size="sm" onClick={a.refit} disabled={c.busy || !s.reportFiles.includes("session.json")}>
          <RefreshCw />
          Refit recording
        </Button>
      </div>
      {r && <Report s={s} a={a} />}
    </div>
  );
}

function Report({ s, a }) {
  const r = s.report;
  const replay = r.replays.find((item) => item.name === s.trace);
  const ref = Number(r.reference_angle_rad) || 0;
  return (
    <>
      <div className="report-toolbar">
        <Segments
          label="Recording segment"
          value={s.trace}
          onChange={a.setTrace}
          options={[
            ["validation", "Validation"],
            ["training", "Training"],
          ]}
        />
        {s.chart !== "torque" && (
          <div className="legend">
            {traces.map(({ key, label }) => (
              <Check
                key={key}
                checked={s.visible[key]}
                onChange={() => a.toggleSeries(key)}
              >
                <i className={`swatch swatch-${key}`} />
                {label}
              </Check>
            ))}
          </div>
        )}
      </div>
      {replay ? (
        <>
          <Panel size="md">
            <div className="metrics result-metrics">
              {axes.map(({ key, label, unit }) => (
                <Metric
                  key={key}
                  label={`${label} error · RMSE`}
                  value={numberText(replay[`post_${key}_rmse`], 4)}
                  unit={unit}
                  detail={`Before ${numberText(replay[`pre_${key}_rmse`], 4)} ${unit}`}
                />
              ))}
            </div>
          </Panel>
          <Segments
            label="Chart view"
            value={s.chart}
            onChange={a.setChart}
            options={[
              ["motion", "Motion"],
              ["residuals", "Residuals"],
              ["torque", "Torque"],
            ]}
          />
          {s.chart === "torque" ? (
            <Chart
              title="Torque"
              unit="Nm"
              series={[
                {
                  label: "Commanded",
                  x: replay.command_t || [],
                  y: replay.command_torque || [],
                  color: "--premium",
                },
                {
                  label: "Reported",
                  x: replay.t,
                  y: replay.reported_torque || [],
                  color: "--foreground",
                },
              ]}
            />
          ) : (
            <MotionCharts
              replay={replay}
              visible={s.visible}
              residual={s.chart === "residuals"}
              reference={ref}
            />
          )}
        </>
      ) : (
        <Panel>
          <Empty
            compact
            icon={FileChartColumn}
            title="No data for this segment"
          >
            <p>Choose another recording segment.</p>
          </Empty>
        </Panel>
      )}
      <Disclosure
        className="disclosure fitted-parameters"
        title="Fitted parameters & diagnostics"
      >
        <div className="parameter-grid">
          {[
            ["Armature", "armature", "kg m²", 1],
            ["Damping", "damping", "Nm s/rad", 1],
            ["Friction", "friction", "Nm", 1],
            ["Delay", "delay", "ms", 1000],
          ].map(([label, key, unit, scale]) => (
            <Metric
              key={key}
              label={label}
              value={conciseNumber(r.fitted[key] * scale)}
              unit={unit}
              detail={`Before ${conciseNumber(r.baseline[key] * scale)}`}
            />
          ))}
        </div>
        <p className="diagnostics">
          {[
            `MuJoCo ${r.mujoco_version}`,
            `${r.diagnostics?.moving_windows || 0} moving seed windows`,
            ...(r.warnings || []),
            r.reference_angle_rad
              ? `Reference ${numberText(r.reference_angle_rad, 2)} rad`
              : "",
          ]
            .filter(Boolean)
            .join("\n")}
        </p>
      </Disclosure>
    </>
  );
}
export function FilesPage({ s, a, c }) {
  return (
    <div className="files-layout">
      <Panel
        className="recording-list"
        size="md"
        title="Saved runs"
        action={
          <div className="saved-run-actions">
            <Button
              variant="outline"
              size="sm"
              onClick={() => a.openRun()}
              disabled={c.busy}
              aria-label="Open recording"
            >
              <FolderOpen /> Open
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Refresh recordings"
              onClick={a.refreshRuns}
              disabled={s.runsLoading}
            >
              <RefreshCw className={s.runsLoading ? "spinning" : ""} />
            </Button>
          </div>
        }
      >
        <div className="runs">
          {s.runs.map((item) => (
            <Item
              key={item.directory}
              title={item.directory}
              className="recording-item"
              variant={s.directory === item.directory ? "muted" : "default"}
            >
              <Button
                variant="ghost"
                className="recording-open"
                onClick={() => a.openRun(item.directory)}
                disabled={c.busy}
                aria-current={
                  s.directory === item.directory ? "true" : undefined
                }
              >
                <ItemContent>
                  <ItemTitle>
                    {item.model
                      ? `${item.model} · ID ${item.motorId}`
                      : item.name}
                  </ItemTitle>
                  <ItemDescription>
                    {Number.isFinite(item.timestamp)
                      ? new Date(item.timestamp).toLocaleString(undefined, {
                          dateStyle: "medium",
                          timeStyle: "short",
                        })
                      : item.name}
                  </ItemDescription>
                  <span className="recording-uuid">
                    {item.uuid ? `UUID ${item.uuid}` : "UUID not recorded"}
                    {item.completed === false ? " · No report" : ""}
                  </span>
                </ItemContent>
              </Button>
              <ItemActions>
                <RunMenu
                  directory={item.directory}
                  files={item.files}
                  a={a}
                  disabled={c.busy}
                  compact
                />
              </ItemActions>
            </Item>
          ))}
        </div>
        {!s.runs.length && (
          <p className="field-hint">
            {s.runsLoading ? "Loading recordings…" : "No saved runs."}
          </p>
        )}
      </Panel>
      <div className="task-content">
        {s.directory ? (
          <Recording s={s} a={a} c={c} />
        ) : (
          <Panel className="files-empty">
            <Empty icon={FolderOpen} title="No recording open">
              <p>Choose a saved run or open a recording.</p>
            </Empty>
          </Panel>
        )}
      </div>
    </div>
  );
}
