import { messageText } from "../../i18n.mjs";
import { useTranslation } from "react-i18next";
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
  const { t } = useTranslation();
  function fields(definitions, baseline = false) {
    const values = baseline ? s.config.baseline : s.config;
    return definitions.map(([key, label, unit, step]) => {
      const [min, max] = s.limits[key];
      return (
        <Field key={key} label={t(label)} unit={unit} type="number"
          min={min} max={max} step={step} value={values[key]} disabled={c.busy}
          onValueChange={(value) => a.changeConfig(key, value, baseline)}
        />
      );
    });
  }
  return (
    <Panel
      className="calibration-controls"
      title={t("Limits")}
      action={
        <Button
          variant="ghost"
          size="sm"
          onClick={a.restorePreset}
          disabled={c.busy}
        >
          <RefreshCw />
          {t("Reset")}
        </Button>
      }
    >
      <div className="control-body">
        <div className="calibration-limits">
          {fields(limitFields)}
        </div>
        <Disclosure className="calibration-advanced" title={t("Advanced settings")}>
          <div className="field-grid">{fields(advancedFields)}</div>
          <h3 className="form-subheading">{t("Baseline model")}</h3>
          <div className="field-grid">{fields(baselineFields, true)}</div>
          <div className="save-location">
            <span>{t("Save folder")}</span>
            <Button
              variant="outline"
              size="sm"
              onClick={a.pickOutput}
              disabled={c.busy}
            >
              <FolderOpen />
              {t("Choose…")}
            </Button>
            <p title={s.outputDirectory || ""}>
              {s.outputDirectory || t("Automatic")}
            </p>
          </div>
        </Disclosure>
        <div className="calibration-start">
          <div>
            <Check checked={s.reviewed} onChange={a.review} disabled={c.busy}>
              {t("Motor secured · limits reviewed")}
            </Check>
            <p className="field-hint">
              {s.previewLoading
                ? t("Checking limits…")
                : t("{{training}} s training · {{validation}} s validation", { training: conciseNumber(s.config.train_seconds), validation: conciseNumber(s.config.validation_seconds) })}
            </p>
          </div>
          <Button onClick={a.calibrate} disabled={!c.calibrate}>
            <Play />
            {t("Start calibration")}
          </Button>
        </div>
      </div>
    </Panel>
  );
}

function CalibrationPreview({ s }) {
  const { t } = useTranslation();
  return (
    <Disclosure className="motion-preview" title={t("Motion preview")}>
      {s.preview ? (
        <div className="stack">
          <SingleTraceChart
            title={t("Target speed")}
            unit="rad/s"
            label={t("Target")}
            x={s.preview.t}
            y={s.preview.velocity}
          />
          {s.preview.torque.some(value => value !== 0) && (
            <SingleTraceChart
              title={t("Torque")}
              unit="Nm"
              label={t("Target")}
              x={s.preview.t}
              y={s.preview.torque}
              color="--premium"
            />
          )}
          <div className="preview-segments">
            {s.preview.segments.map((segment, i) => (
              <Badge key={`${segment.name}-${i}`} variant="secondary">
                {t(segment.name)} · {conciseNumber(segment.end - segment.start)} s
              </Badge>
            ))}
          </div>
        </div>
      ) : (
        <Empty
          compact
          icon={s.previewLoading ? LoaderCircle : CircleAlert}
          title={s.previewLoading ? t("Loading preview…") : t("Check the limits")}
        />
      )}
    </Disclosure>
  );
}

export function CalibratePage({ s, a, c }) {
  const { t } = useTranslation();
  if (!s.config) {
    const empty = (icon, title, message) => (
      <Empty compact icon={icon} title={title}>{message && <p>{message}</p>}</Empty>
    );
    if (s.motor?.issue) return empty(CircleAlert, t("Motor unavailable"), messageText(s.motor.issue));
    if (s.busy === "plan") return empty(LoaderCircle, t("Loading preset…"));
    if (s.motor) return empty(Cable, t("Preset unavailable"), t("Select another motor or scan again."));
    if (s.motors.length > 1) return empty(Cable, t("Select a motor"), t("Choose a motor above."));
    return empty(Cable, t("No motor connected"), t("Scan above to select your motor."));
  }
  return (
    <div className="stack calibration-workspace">
      <CalibrationControls s={s} a={a} c={c} />
      <CalibrationPreview s={s} />
    </div>
  );
}
