import { messageText } from "../../i18n.mjs";
import { formatLocale } from "../language.mjs";
import { useTranslation } from "react-i18next";
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
  const { t } = useTranslation();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant={compact ? "ghost" : "outline"}
            size={compact ? "icon-sm" : "sm"}
            disabled={disabled}
            aria-label={compact ? t("Run actions") : undefined}
          />
        }
      >
        {compact ? (
          <MoreHorizontal />
        ) : (
          <>
            <Download /> {t("Download")}
          </>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={() => a.exportRun(directory)}>
          <Download /> {t("Entire run (.zip)")}
        </DropdownMenuItem>
        {[
          ["training.csv", t("Training recording (.csv)")],
          ["validation.csv", t("Validation recording (.csv)")],
          ["calibration.json", t("Calibration (.json)")],
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
          <Trash2 /> {t("Delete run")}
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
  const { t } = useTranslation();
  return axes.map(({ key, label, unit }) => {
    const measured = replay[`measured_${key}`];
    const offset = key === "position" ? reference : 0;
    const series = traces
      .filter(trace => visible[trace.key] && !(residual && trace.key === "measured"))
      .map(({ prefix, label, color }) => {
        let y = replay[`${prefix}_${key}`];
        if (residual) y = y.map((value, i) => value - measured[i]);
        else if (offset) y = y.map(value => value + offset);
        return { label: t(label), color, x: replay.t, y };
      });
    return (
      <Chart key={key} title={residual ? t("{{label}} residual", { label: t(label) }) : t(label)} unit={unit} series={series} />
    );
  });
});

function Recording({ s, a, c }) {
  const { t } = useTranslation();
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
              ? new Date(recordedAt).toLocaleString(formatLocale, {
                  dateStyle: "medium",
                  timeStyle: "short",
                })
              : folder}
          </p>
          <p className="recording-identity">
            {t("Actuator UUID")} <code>{s.reportUuid || t("Not recorded")}</code>
          </p>
        </div>
        <Badge variant={r?.accepted ? "success" : "warning"}>
          {r?.accepted ? <CheckCircle2 /> : <CircleAlert />}
          {r ? (r.accepted ? t("Validated") : t("Needs improvement")) : t("No report")}
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
          {t("Show folder")}
        </Button>
        <Button variant="ghost" size="sm" onClick={a.copyPath}>
          <Copy />
          {t("Copy path")}
        </Button>
        <Button variant="ghost" size="sm" onClick={a.refit} disabled={c.busy || !s.reportFiles.includes("session.json")}>
          <RefreshCw />
          {t("Refit recording")}
        </Button>
      </div>
      {r && <Report s={s} a={a} />}
    </div>
  );
}

function Report({ s, a }) {
  const { t } = useTranslation();
  const r = s.report;
  const replay = r.replays.find((item) => item.name === s.trace);
  const ref = Number(r.reference_angle_rad) || 0;
  return (
    <>
      <div className="report-toolbar">
        <Segments
          label={t("Recording segment")}
          value={s.trace}
          onChange={a.setTrace}
          options={[
            ["validation", t("Validation")],
            ["training", t("Training")],
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
                {t(label)}
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
                  label={t("{{label}} error · RMSE", { label: t(label) })}
                  value={numberText(replay[`post_${key}_rmse`], 4)}
                  unit={unit}
                  detail={t("Before {{value}} {{unit}}", { value: numberText(replay[`pre_${key}_rmse`], 4), unit })}
                />
              ))}
            </div>
          </Panel>
          <Segments
            label={t("Chart view")}
            value={s.chart}
            onChange={a.setChart}
            options={[
              ["motion", t("Motion")],
              ["residuals", t("Residuals")],
              ["torque", t("Torque")],
            ]}
          />
          {s.chart === "torque" ? (
            <Chart
              title={t("Torque")}
              unit="Nm"
              series={[
                {
                  label: t("Commanded"),
                  x: replay.command_t || [],
                  y: replay.command_torque || [],
                  color: "--premium",
                },
                {
                  label: t("Reported"),
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
            title={t("No data for this segment")}
          >
            <p>{t("Choose another recording segment.")}</p>
          </Empty>
        </Panel>
      )}
      <Disclosure
        className="disclosure fitted-parameters"
        title={t("Fitted parameters & diagnostics")}
      >
        <div className="parameter-grid">
          {[
            [t("Armature"), "armature", "kg m²", 1],
            [t("Damping"), "damping", "Nm s/rad", 1],
            [t("Friction"), "friction", "Nm", 1],
            [t("Delay"), "delay", "ms", 1000],
          ].map(([label, key, unit, scale]) => (
            <Metric
              key={key}
              label={label}
              value={conciseNumber(r.fitted[key] * scale)}
              unit={unit}
              detail={t("Before {{value}}", { value: conciseNumber(r.baseline[key] * scale) })}
            />
          ))}
        </div>
        <p className="diagnostics">
          {[
            `MuJoCo ${r.mujoco_version}`,
            t("{{count}} moving seed windows", { count: r.diagnostics?.moving_windows || 0 }),
            ...(r.warnings || []).map(messageText),
            r.reference_angle_rad
              ? t("Reference {{angle}} rad", { angle: numberText(r.reference_angle_rad, 2) })
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
  const { t } = useTranslation();
  return (
    <div className="files-layout">
      <Panel
        className="recording-list"
        size="md"
        title={t("Saved runs")}
        action={
          <div className="saved-run-actions">
            <Button
              variant="outline"
              size="sm"
              onClick={() => a.openRun()}
              disabled={c.busy}
              aria-label={t("Open recording")}
            >
              <FolderOpen /> {t("Open")}
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t("Refresh recordings")}
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
                      ? new Date(item.timestamp).toLocaleString(formatLocale, {
                          dateStyle: "medium",
                          timeStyle: "short",
                        })
                      : item.name}
                  </ItemDescription>
                  <span className="recording-uuid">
                    {item.uuid ? `UUID ${item.uuid}` : t("UUID not recorded")}
                    {item.completed === false ? t(" · No report") : ""}
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
            {s.runsLoading ? t("Loading recordings…") : t("No saved runs.")}
          </p>
        )}
      </Panel>
      <div className="task-content">
        {s.directory ? (
          <Recording s={s} a={a} c={c} />
        ) : (
          <Panel className="files-empty">
            <Empty icon={FolderOpen} title={t("No recording open")}>
              <p>{t("Choose a saved run or open a recording.")}</p>
            </Empty>
          </Panel>
        )}
      </div>
    </div>
  );
}
