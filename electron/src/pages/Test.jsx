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
import { Chart } from "../Chart.jsx";
import { numberText } from "../controller.mjs";

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
  if (!c.motor)
    return (
      <Empty compact icon={Cable} title="No motor selected">
        Scan above to start testing.
      </Empty>
    );
  const status = s.manualStatus;
  const canDisable = c.manual && Boolean(status?.enabled || status?.preparing);
  const feedbackLabel =
    status?.preparing && c.manual
      ? "Checking watchdog"
      : c.fresh
        ? status.faults
          ? "Motor fault"
          : status.enabled
            ? "Enabled"
            : "Disabled"
        : "No live feedback";
  const specTorque = s.preview?.spec?.rated_torque;
  return (
    <div className="task-layout">
      <div className="task-content stack">
        <Panel
          title="Live feedback"
          description={
            s.motor ? `${s.motor.model} · ID ${s.motor.id}` : undefined
          }
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
            {[
              ["Position", "position_rad", "rad", 3],
              ["Speed", "velocity_rad_s", "rad/s", 3],
              ["Torque", "torque_nm", "Nm", 3],
              ["Temperature", "temperature_c", "°C", 1],
            ].map(([label, key, unit, digits]) => (
              <Metric
                key={key}
                label={label}
                value={
                  c.fresh
                    ? numberText(
                        status[key] +
                          (key === "position_rad" ? s.referenceAngle : 0),
                        digits,
                      )
                    : "—"
                }
                unit={unit}
              />
            ))}
          </div>
          {(status?.error || status?.stop_reason) && (
            <p className="feedback-reason" role="status">
              {status.error || status.stop_reason}
            </p>
          )}
          {c.fresh && (
            <p className="field-hint">
              Mode {status.mode} · Faults 0x
              {Number(status.faults).toString(16).padStart(2, "0")}
            </p>
          )}
        </Panel>
        {s.manualHistory.length ? (
          ["position_rad", "velocity_rad_s", "torque_nm"].map((key, i) => (
            <Chart
              key={key}
              title={["Position", "Speed", "Torque"][i]}
              unit={["rad", "rad/s", "Nm"][i]}
              compact
              series={[
                {
                  label: "Measured",
                  x: s.manualHistory.map((v) => v.sample_t),
                  y: s.manualHistory.map(
                    (v) => v[key] + (i === 0 ? s.referenceAngle : 0),
                  ),
                  color: "--info-foreground",
                },
              ]}
            />
          ))
        ) : (
          <Panel>
            <Empty icon={Activity} title="No live data">
              <p>Start monitoring to read motor feedback.</p>
            </Empty>
          </Panel>
        )}
      </div>
      <div className="task-aside stack">
        <Panel title="Motor controls" size="md">
          <Button
            className="full"
            variant="outline"
            onClick={a.monitor}
            disabled={!c.monitor}
          >
            {c.manual ? <CircleStop /> : <Play />}
            {c.manual ? "Stop monitoring" : "Start monitoring"}
          </Button>
          <Separator className="control-divider" />
          <div className="range-label">
            <label id="jog-speed-label">Jog speed</label>
            <span>
              {numberText(Number(s.jogSpeed), 2)} <small>rad/s</small>
            </span>
          </div>
          <Slider
            className="speed-slider"
            aria-labelledby="jog-speed-label"
            min={0.01}
            max={Math.max(
              0.01,
              Math.min(Number(s.config?.speed_limit || 1) * 0.1, 1),
            )}
            step={0.01}
            value={Number(s.jogSpeed)}
            onValueChange={a.setJogSpeed}
            disabled={
              !c.motor ||
              (c.busy && !c.manual) ||
              Boolean(c.manual && (status?.enabled || status?.preparing))
            }
          />
          <Check
            checked={s.jogReviewed}
            onChange={a.reviewJog}
            disabled={
              !c.motor ||
              (c.busy && !c.manual) ||
              Boolean(c.manual && (status?.enabled || status?.preparing))
            }
          >
            Motor secured · shaft clear
          </Check>
          <Button
            className="full"
            variant={canDisable ? "destructive" : "default"}
            onClick={canDisable ? a.disable : a.enable}
            disabled={canDisable ? !c.disable : !c.enable}
          >
            <Power />
            {canDisable ? "Disable motor" : "Enable motor"}
          </Button>
          <div className="jog-controls">
            <JogButton direction={-1} a={a} disabled={!c.jog}>
              <ArrowLeft />
              Jog −
            </JogButton>
            <JogButton direction={1} a={a} disabled={!c.jog}>
              Jog +<ArrowRight />
            </JogButton>
          </div>
          <p className="jog-hint">Hold to jog. Release to stop.</p>
          <p className="field-hint">
            Torque limit{" "}
            {specTorque == null
              ? "—"
              : numberText(
                  Math.min(Number(s.config?.torque_limit), specTorque * 0.1),
                  2,
                )}{" "}
            Nm · travel ±
            {s.config ? numberText(Number(s.config.travel_limit), 3) : "—"} rad
            from enable.
          </p>
          <Separator className="control-divider" />
          <Button
            className="full"
            variant="ghost"
            onClick={() => a.zero(true)}
            disabled={!c.zero}
          >
            <Target />
            Set position as zero
          </Button>
        </Panel>
        <p className="aside-note">
          <ShieldCheck />
          Keep a physical stop available.
        </p>
      </div>
    </div>
  );
}
