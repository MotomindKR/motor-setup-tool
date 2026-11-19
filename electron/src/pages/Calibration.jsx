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
import { SingleTraceChart } from "../Chart.jsx";
import { conciseNumber } from "../format.mjs";

const limitFields = [
  ["torque_limit", "Torque limit", "Nm", 0.01],
  ["speed_limit", "Speed cutoff", "rad/s", 0.1],
  ["travel_limit", "Travel limit", "±rad", 0.5],
  ["temperature_limit", "Temperature cutoff", "°C", 1],
];
const advancedFields = [
  ["train_seconds", "Training duration", "s", 1],
  ["validation_seconds", "Validation duration", "s", 1],
  ["sample_hz", "Sample rate", "Hz", 10],
  ["sweep_start_hz", "Sweep start", "Hz", 0.05],
  ["sweep_end_hz", "Sweep end", "Hz", 0.1],
];
const baselineFields = [
  ["armature", "Armature", "kg m²", 0.001],
  ["damping", "Damping", "Nm s/rad", 0.001],
  ["friction", "Friction", "Nm", 0.001],
  ["delay", "Delay", "s", 0.001],
];

function CalibrationControls({ s, a, c }) {
  function fields(definitions, baseline = false) {
    const values = baseline ? s.config.baseline : s.config;
    return definitions.map(([key, label, unit, step]) => {
      const [min, max] = s.limits[key];
      return (
        <Field key={key} label={label} unit={unit} type="number"
          min={min} max={max} step={step} value={values[key]} disabled={c.busy}
          onValueChange={(value) => a.changeConfig(key, value, baseline)}
        />
      );
    });
  }
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
          {fields(limitFields)}
        </div>
        <Disclosure className="calibration-advanced" title="Advanced settings">
          <div className="field-grid">{fields(advancedFields)}</div>
          <h3 className="form-subheading">Baseline model</h3>
          <div className="field-grid">{fields(baselineFields, true)}</div>
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
          <SingleTraceChart
            title="Target speed"
            unit="rad/s"
            label="Target"
            x={s.preview.t}
            y={s.preview.velocity}
          />
          {s.preview.torque.some(value => value !== 0) && (
            <SingleTraceChart
              title="Torque"
              unit="Nm"
              label="Target"
              x={s.preview.t}
              y={s.preview.torque}
              color="--premium"
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
  if (!s.config) {
    const empty = (icon, title, message) => (
      <Empty compact icon={icon} title={title}>{message && <p>{message}</p>}</Empty>
    );
    if (s.motor?.issue) return empty(CircleAlert, "Motor unavailable", s.motor.issue);
    if (s.busy === "plan") return empty(LoaderCircle, "Loading preset…");
    if (s.motor) return empty(Cable, "Preset unavailable", "Select another motor or scan again.");
    if (s.motors.length > 1) return empty(Cable, "Select a motor", "Choose a motor above.");
    return empty(Cable, "No motor connected", "Scan above to select your motor.");
  }
  return (
    <div className="stack calibration-workspace">
      <CalibrationControls s={s} a={a} c={c} />
      <CalibrationPreview s={s} />
    </div>
  );
}
