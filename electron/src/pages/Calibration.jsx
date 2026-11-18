import React from "react";
import {
  Cable,
  CircleAlert,
  FolderOpen,
  LoaderCircle,
  Play,
  RefreshCw,
} from "lucide-react";
import { Badge } from "@motomindkr/ui/components/badge";
import { Panel, Field, Check, Button, Empty, Disclosure } from "../ui.jsx";
import { Chart } from "../Chart.jsx";
import { configFields, baselineFields } from "../controller.mjs";
import { conciseNumber } from "../format.mjs";
import { Report } from "./Recordings.jsx";

function CalibrationControls({ s, a, c }) {
  return (
    <Panel
      className="calibration-controls"
      title="Limits"
      action={
        <Button
          variant="ghost"
          size="sm"
          onClick={a.restorePreset}
          disabled={c.busy}
        >
          <RefreshCw />
          Reset
        </Button>
      }
    >
      <div className="control-body">
        <div className="calibration-limits">
          {configFields
            .slice(0, 4)
            .map(([key, label, unit, min, max, step]) => (
              <Field
                key={key}
                label={label}
                unit={unit}
                type="number"
                min={min}
                max={max}
                step={step}
                value={s.config[key]}
                disabled={c.busy}
                onValueChange={(value) => a.changeConfig(key, value)}
              />
            ))}
        </div>
        <Disclosure className="calibration-advanced" title="Advanced settings">
          <div className="field-grid">
            {configFields.slice(4).map(([key, label, unit, min, max, step]) => (
              <Field
                key={key}
                label={label}
                unit={unit}
                type="number"
                min={min}
                max={max}
                step={step}
                value={s.config[key]}
                disabled={c.busy}
                onValueChange={(value) => a.changeConfig(key, value)}
              />
            ))}
          </div>
          <h3 className="form-subheading">Baseline model</h3>
          <div className="field-grid">
            {baselineFields.map(([key, label, unit, min, max, step]) => (
              <Field
                key={key}
                label={label}
                unit={unit}
                type="number"
                min={min}
                max={max}
                step={step}
                value={s.config.baseline[key]}
                disabled={c.busy}
                onValueChange={(value) => a.changeConfig(key, value, true)}
              />
            ))}
          </div>
          <div className="save-location">
            <span>Save folder</span>
            <Button
              variant="outline"
              size="sm"
              onClick={a.pickOutput}
              disabled={c.busy}
            >
              <FolderOpen />
              Choose…
            </Button>
            <p title={s.outputDirectory || ""}>
              {s.outputDirectory || "Automatic"}
            </p>
          </div>
        </Disclosure>
        <div className="calibration-start">
          <div>
            <Check checked={s.reviewed} onChange={a.review} disabled={c.busy}>
              Motor secured · limits reviewed
            </Check>
            <p className="field-hint">
              {s.previewLoading
                ? "Checking limits…"
                : `${conciseNumber(s.config.train_seconds)} s training · ${conciseNumber(s.config.validation_seconds)} s validation`}
            </p>
          </div>
          <Button onClick={a.calibrate} disabled={!c.calibrate}>
            <Play />
            Start calibration
          </Button>
        </div>
      </div>
    </Panel>
  );
}

function CalibrationPreview({ s }) {
  return (
    <Disclosure className="motion-preview" title="Motion preview">
      {s.preview ? (
        <div className="stack">
          <Chart
            title="Target speed"
            unit="rad/s"
            series={[
              {
                label: "Target",
                x: s.preview.t,
                y: s.preview.velocity,
                color: "--info-foreground",
              },
            ]}
          />
          {s.preview.torque.some((value) => value !== 0) && (
            <Chart
              title="Torque"
              unit="Nm"
              series={[
                {
                  label: "Target",
                  x: s.preview.t,
                  y: s.preview.torque,
                  color: "--premium",
                },
              ]}
            />
          )}
          <div className="preview-segments">
            {s.preview.segments.map((segment, i) => (
              <Badge key={`${segment.name}-${i}`} variant="secondary">
                {segment.name} · {conciseNumber(segment.end - segment.start)} s
              </Badge>
            ))}
          </div>
        </div>
      ) : (
        <Empty
          compact
          icon={s.previewLoading ? LoaderCircle : CircleAlert}
          title={s.previewLoading ? "Loading preview…" : "Check the limits"}
        />
      )}
    </Disclosure>
  );
}

export function CalibratePage({ s, a, c }) {
  if (s.report)
    return (
      <div className="stack">
        <div className="calibration-result-action">
          <Button
            variant="outline"
            onClick={a.newCalibration}
            disabled={c.busy}
          >
            <RefreshCw />
            New calibration
          </Button>
        </div>
        <Report s={s} a={a} c={c} />
      </div>
    );
  if (!s.config)
    return (
      <Empty
        compact
        icon={
          s.motor?.issue
            ? CircleAlert
            : s.busy === "plan"
              ? LoaderCircle
              : Cable
        }
        title={
          s.motor?.issue
            ? "Motor unavailable"
            : s.busy === "plan"
              ? "Loading preset…"
              : s.motor
                ? "Preset unavailable"
                : s.motors.length > 1
                  ? "Select a motor"
                  : "No motor connected"
        }
      >
        <p>
          {s.motor?.issue ||
            (s.busy === "plan"
              ? null
              : s.motor
                ? "Select another motor or scan again."
                : s.motors.length > 1
                  ? "Choose a motor above."
                  : "Scan above to select your motor.")}
        </p>
      </Empty>
    );
  return (
    <div className="stack calibration-workspace">
      <CalibrationControls s={s} a={a} c={c} />
      <CalibrationPreview s={s} />
    </div>
  );
}
