import React from "react";
import {
  ArrowUpRight,
  Cable,
  ChevronDown,
  RefreshCw,
  Search,
} from "lucide-react";
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from "@motomindkr/ui/components/collapsible";
import { Button, Field, Choice, Disclosure } from "../ui.jsx";
import { uuidText } from "../controller.mjs";

export function Connection({ s, a, c, platform }) {
  const con = s.connection;
  const bus = s.interfaces.find((item) => item.name === con.bus);
  const usb = s.usbAdapters.find((item) => item.id === con.usb);
  const status =
    con.transport === "socketcan"
      ? !bus
        ? "No CAN interface found"
        : !bus.up
          ? "CAN bus is down"
          : `${bus.bitrate ? `${bus.bitrate / 1e6} Mbps` : "CAN ready"}${bus.state === "ERROR-ACTIVE" ? "" : ` · ${bus.state}`}`
      : !s.usbAdapters.length
        ? "Connect a GS USB adapter, then refresh."
        : !usb
          ? "Choose a USB adapter."
          : usb.accessible
            ? "Ready · 1 Mbps"
            : platform === "linux"
              ? "USB access denied. Install the USB access rule and reconnect."
              : "USB access denied. Close other apps using the adapter.";
  const change = (key) => (value) => a.changeConnection(key, value);
  return (
    <Collapsible
      className="connection-card"
      aria-label="Motor connection"
      open={s.connectionOpen}
      onOpenChange={(open) => {
        if (open !== s.connectionOpen) a.toggleConnection();
      }}
    >
      <div className="connection-heading">
        <CollapsibleTrigger
          render={<Button variant="ghost" className="connection-toggle" />}
        >
          <Cable />
          <span>Connection</span>
          <ChevronDown className={s.connectionOpen ? "rotated" : ""} />
        </CollapsibleTrigger>
        {s.motor && (
          <span className="connection-summary">
            {s.motor.model || "Motor"} · ID {s.motor.id} ·{" "}
            {con.transport === "socketcan" ? con.bus : "GS USB"}
          </span>
        )}
        <Button
          variant="ghost"
          size="sm"
          aria-label="Refresh adapters"
          onClick={a.refreshInterfaces}
          disabled={c.busy}
        >
          <RefreshCw className={s.refreshingAdapters ? "spinning" : ""} />
          {s.refreshingAdapters ? "Checking…" : "Refresh"}
        </Button>
      </div>
      <CollapsibleContent className="connection-fields">
        <div
          className="connection-grid"
          style={{
            "--connection-fields":
              (platform === "linux" ? 2 : 1) + (s.motors.length ? 1 : 0),
          }}
        >
          {platform === "linux" && (
            <Field label="Adapter">
              <Choice
                value={con.transport}
                onChange={change("transport")}
                disabled={c.busy}
                options={[
                  { value: "socketcan", label: "SocketCAN" },
                  { value: "gsusb", label: "GS USB" },
                ]}
              />
            </Field>
          )}
          {con.transport === "socketcan" ? (
            <Field label="CAN bus">
              <Choice
                value={con.bus}
                onChange={change("bus")}
                options={s.interfaces.map((item) => ({
                  value: item.name,
                  label: item.name,
                }))}
                placeholder="No interfaces found"
                disabled={c.busy || !s.interfaces.length}
              />
            </Field>
          ) : (
            <Field label="USB adapter">
              <Choice
                value={con.usb}
                onChange={change("usb")}
                options={s.usbAdapters.map((item) => ({
                  value: item.id,
                  label: `GS USB · ${item.bus_id}:${item.address}${item.accessible ? "" : " · Access denied"}`,
                }))}
                placeholder="No USB adapters found"
                disabled={c.busy || !s.usbAdapters.length}
              />
            </Field>
          )}
          {s.motors.length > 0 && (
            <Field label="Motor">
              <Choice
                value={s.motor ? String(s.motor.id) : ""}
                onChange={a.selectMotor}
                options={s.motors.map((item) => ({
                  value: String(item.id),
                  label: `${item.model || "Unknown model"} · ID ${item.id}`,
                }))}
                disabled={c.busy}
                placeholder="Select a motor"
              />
            </Field>
          )}
          <Button
            className="scan-button"
            variant={s.motor ? "outline" : "default"}
            onClick={a.scan}
            disabled={c.busy || !c.ready}
            title="Scanning may stop motors on this bus"
          >
            <Search />
            {s.busy === "scan" ? "Scanning…" : "Scan motors"}
          </Button>
        </div>
        <div className="connection-meta">
          <span>
            <span className={`status-dot ${c.ready ? "ready" : ""}`} />
            {status}
          </span>
          {con.transport === "socketcan" && (
            <Button
              variant="ghost"
              size="sm"
              disabled={c.busy || !bus}
              onClick={a.restartCan}
            >
              {c.ready ? "Restart CAN" : "Bring up CAN"}
              <ArrowUpRight />
            </Button>
          )}
        </div>
        <Disclosure className="connection-options" title="Connection options">
          <div className="connection-host">
            <Field
              label="Host ID"
              type="number"
              min="1"
              max="254"
              value={con.hostId}
              onValueChange={change("hostId")}
              disabled={c.busy}
            />
          </div>
          {usb && con.transport === "gsusb" && (
            <p className="motor-identity">
              USB {usb.vendor_id.toString(16).padStart(4, "0")}:
              {usb.product_id.toString(16).padStart(4, "0")} · {usb.bus_id}:
              {usb.address}
            </p>
          )}
          {s.motor && (
            <p className="motor-identity">
              Firmware {s.motor.firmware || "unknown"} · UUID{" "}
              {uuidText(s.motor) || "unknown"}
            </p>
          )}
        </Disclosure>
        {s.motor?.issue && (
          <p className="feedback-reason" role="alert">
            {s.motor.issue}
          </p>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}
