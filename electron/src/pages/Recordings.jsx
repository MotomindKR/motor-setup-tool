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

function Report({ s, a, c }) {
  const r = s.report;
  const replay = r.replays.find((item) => item.name === s.trace);
  const ref = Number(r.reference_angle_rad) || 0;
  const folder = s.directory?.split(/[\\/]/).at(-1);
  const recordedAt =
    s.runs.find((run) => run.directory === s.directory)?.timestamp ??
    Number(/^\d{13}(?=-|$)/.exec(folder || "")?.[0]);
  const colors = {
    measured: "--foreground",
    before: "--premium",
    after: "--info-foreground",
  };
  const series = (measured, before, after, residual = false, offset = 0) =>
    [
      s.visible.measured &&
        !residual && {
          label: "Measured",
          x: replay.t,
          y: measured.map((v) => v + offset),
          color: colors.measured,
        },
      s.visible.before && {
        label: "Before",
        x: replay.t,
        y: residual
          ? before.map((v, i) => v - measured[i])
          : before.map((v) => v + offset),
        color: colors.before,
      },
      s.visible.after && {
        label: "After",
        x: replay.t,
        y: residual
          ? after.map((v, i) => v - measured[i])
          : after.map((v) => v + offset),
        color: colors.after,
      },
    ].filter(Boolean);
  return (
    <div className="stack report">
      <div className="section-heading">
        <div>
          <h2>
            {r.model} <span className="muted">/ ID {r.motor_id}</span>
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
        <Badge variant={r.accepted ? "success" : "warning"}>
          {r.accepted ? <CheckCircle2 /> : <CircleAlert />}
          {r.accepted ? "Validated" : "Needs improvement"}
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
        <Button variant="ghost" size="sm" onClick={a.refit} disabled={c.busy}>
          <RefreshCw />
          Refit recording
        </Button>
      </div>
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
        <div className="legend">
          {["measured", "before", "after"].map((key) => (
            <Check
              key={key}
              checked={s.visible[key]}
              onChange={() => a.toggleSeries(key)}
            >
              <i className={`swatch swatch-${key}`} />
              {key.charAt(0).toUpperCase() + key.slice(1)}
            </Check>
          ))}
        </div>
      </div>
      {replay ? (
        <>
          <Panel size="md">
            <div className="metrics result-metrics">
              <Metric
                label="Velocity error · RMSE"
                value={numberText(replay.post_velocity_rmse, 4)}
                unit="rad/s"
                detail={`Before ${numberText(replay.pre_velocity_rmse, 4)} rad/s`}
              />
              <Metric
                label="Position error · RMSE"
                value={numberText(replay.post_position_rmse, 4)}
                unit="rad"
                detail={`Before ${numberText(replay.pre_position_rmse, 4)} rad`}
              />
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
            <>
              <Chart
                title={
                  s.chart === "residuals" ? "Velocity residual" : "Velocity"
                }
                unit="rad/s"
                series={series(
                  replay.measured_velocity,
                  replay.pre_velocity,
                  replay.post_velocity,
                  s.chart === "residuals",
                )}
              />
              <Chart
                title={
                  s.chart === "residuals" ? "Position residual" : "Position"
                }
                unit="rad"
                series={series(
                  replay.measured_position,
                  replay.pre_position,
                  replay.post_position,
                  s.chart === "residuals",
                  ref,
                )}
              />
            </>
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
    </div>
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
                disabled={c.busy || item.completed === false}
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
                    {item.completed === false ? " · Incomplete run" : ""}
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
        {s.report ? (
          <Report s={s} a={a} c={c} />
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
