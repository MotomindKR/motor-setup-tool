import { messageText } from "../i18n.mjs";
import { useTranslation } from "react-i18next";
import React from "react";
import {
  Activity,
  Cable,
  ArrowLeft,
  ArrowRight,
  CircleStop,
  Play,
  Power,
  ShieldCheck,
  Target,
} from "lucide-react";
import { Badge } from "@motomindkr/ui/components/badge";
import { Slider } from "@motomindkr/ui/components/slider";
import { Separator } from "@motomindkr/ui/components/separator";
import { Panel, Button, Check, Empty, Metric } from "../ui.jsx";
import { SingleTraceChart } from "../Chart.jsx";
import { maxJogSpeed } from "../controller.mjs";
import { numberText } from "../format.mjs";

const motionSignals = [
  ["Position", "position_rad", "rad", 3],
  ["Speed", "velocity_rad_s", "rad/s", 3],
  ["Torque", "torque_nm", "Nm", 3],
];
const feedbackSignals = [...motionSignals, ["Temperature", "temperature_c", "°C", 1]];

function JogButton({ direction, disabled, a, children }) {
  const release = () => a.release();
  return (
    <Button
      variant="outline"
      disabled={disabled}
      className="jog-button"
      onPointerDown={(e) => {
        if (e.button !== 0 || disabled) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        a.jog(direction);
      }}
      onPointerUp={release}
      onPointerCancel={release}
      onLostPointerCapture={release}
      onKeyDown={(e) => {
        if ([" ", "Enter"].includes(e.key) && !disabled) {
          e.preventDefault();
          if (!e.repeat) a.jog(direction);
        }
      }}
      onKeyUp={(e) => {
        if (e.key === " " || e.key === "Enter") release();
      }}
      onBlur={release}
      onContextMenu={(e) => e.preventDefault()}
    >
      {children}
    </Button>
  );
}
export function TestPage({ s, a, c }) {
  const { t } = useTranslation();
  if (!c.motor)
    return (
      <Empty compact icon={Cable} title={t("No motor selected")}>
        {t("Scan above to start testing.")}
      </Empty>
    );
  const status = s.manualStatus;
  const sampleTimes = s.manualHistory.map(sample => sample.sample_t);
  const displayValue = (sample, key) => sample[key] + (key === "position_rad" ? s.referenceAngle : 0);
  const canDisable = c.manual && Boolean(status?.enabled || status?.preparing);
  const controlsLocked = (c.busy && !c.manual) || canDisable;
  const feedbackLabel =
    status?.preparing && c.manual
      ? t("Checking watchdog")
      : c.fresh
        ? status.faults
          ? t("Motor fault")
          : status.enabled
            ? t("Enabled")
            : t("Disabled")
        : t("No live feedback");
  const specTorque = s.preview?.spec?.rated_torque;
  return (
    <div className="task-layout">
      <div className="task-content stack">
        <Panel
          title={t("Live feedback")}
          description={`${s.motor.model} · ID ${s.motor.id}`}
          action={
            <Badge
              variant={
                c.fresh && status?.faults
                  ? "error"
                  : c.fresh
                    ? "info"
                    : "secondary"
              }
            >
              {feedbackLabel}
            </Badge>
          }
        >
          <div className="metrics live-metrics">
            {feedbackSignals.map(([label, key, unit, digits]) => (
              <Metric
                key={key}
                label={t(label)}
                value={c.fresh ? numberText(displayValue(status, key), digits) : "—"}
                unit={unit}
              />
            ))}
          </div>
          {(status?.error || status?.stop_reason) && (
            <p className="feedback-reason" role="status">
              {messageText(status.error || status.stop_reason)}
            </p>
          )}
          {c.fresh && (
            <p className="field-hint">
              {t("Mode {{mode}} · Faults 0x{{faults}}", {
                mode: status.mode, faults: Number(status.faults).toString(16).padStart(2, "0"),
              })}
            </p>
          )}
        </Panel>
        {s.manualHistory.length ? (
          motionSignals.map(([label, key, unit]) => (
            <SingleTraceChart
              key={key}
              title={t(label)}
              unit={unit}
              compact
              label={t("Measured")}
              x={sampleTimes}
              y={s.manualHistory.map(sample => displayValue(sample, key))}
            />
          ))
        ) : (
          <Panel>
            <Empty icon={Activity} title={t("No live data")}>
              <p>{t("Start monitoring to read motor feedback.")}</p>
            </Empty>
          </Panel>
        )}
      </div>
      <div className="task-aside stack">
        <Panel title={t("Motor controls")} size="md">
          <Button
            className="full"
            variant="outline"
            onClick={a.monitor}
            disabled={!c.monitor}
          >
            {c.manual ? <CircleStop /> : <Play />}
            {c.manual ? t("Stop monitoring") : t("Start monitoring")}
          </Button>
          <Separator className="control-divider" />
          <div className="range-label">
            <label id="jog-speed-label">{t("Jog speed")}</label>
            <span>
              {numberText(Number(s.jogSpeed), 2)} <small>rad/s</small>
            </span>
          </div>
          <Slider
            className="speed-slider"
            aria-labelledby="jog-speed-label"
            min={0.01}
            max={maxJogSpeed(s.config)}
            step={0.01}
            value={Number(s.jogSpeed)}
            onValueChange={a.setJogSpeed}
            disabled={controlsLocked}
          />
          <Check
            checked={s.jogReviewed}
            onChange={a.reviewJog}
            disabled={controlsLocked}
          >
            {t("Motor secured · shaft clear")}
          </Check>
          <Button
            className="full"
            variant={canDisable ? "destructive" : "default"}
            onClick={canDisable ? a.disable : a.enable}
            disabled={canDisable ? !c.disable : !c.enable}
          >
            <Power />
            {canDisable ? t("Disable motor") : t("Enable motor")}
          </Button>
          <div className="jog-controls">
            <JogButton direction={-1} a={a} disabled={!c.jog}>
              <ArrowLeft />
              {t("Jog −")}
            </JogButton>
            <JogButton direction={1} a={a} disabled={!c.jog}>
              {t("Jog +")}<ArrowRight />
            </JogButton>
          </div>
          <p className="jog-hint">{t("Hold to jog. Release to stop.")}</p>
          <p className="field-hint">
            {t("Torque limit {{torque}} Nm · travel ±{{travel}} rad from enable.", {
              torque: specTorque == null ? "—" : numberText(Math.min(Number(s.config?.torque_limit), specTorque * 0.1), 2),
              travel: s.config ? numberText(Number(s.config.travel_limit), 3) : "—",
            })}
          </p>
          <Separator className="control-divider" />
          <Button
            className="full"
            variant="ghost"
            onClick={() => a.zero(true)}
            disabled={!c.zero}
          >
            <Target />
            {t("Set position as zero")}
          </Button>
        </Panel>
        <p className="aside-note">
          <ShieldCheck />
          {t("Keep a physical stop available.")}
        </p>
      </div>
    </div>
  );
}
