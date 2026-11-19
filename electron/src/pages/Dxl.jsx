import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Alert, AlertDescription } from "@motomindkr/ui/components/alert";
import { Badge } from "@motomindkr/ui/components/badge";
import { DataTable } from "@motomindkr/ui/components/data-table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@motomindkr/ui/components/dialog";
import { FreshnessIndicator } from "@motomindkr/ui/components/freshness-indicator";
import { Button, Choice, Field, Panel } from "../ui.jsx";

const column = (id, header) => ({ id, header, value: (row) => row[id] });
const angle = (key, label) => ({
  id: key,
  header: label,
  value: (row) => row[key],
  align: "right",
  cell: (row) =>
    `${row[key].toFixed(3)} rad / ${row[key.replace("radians", "degrees")].toFixed(1)}°`,
});
const columns = [
  column("motor_id", "ID"),
  column("name", "Model"),
  column("firmware", "FW"),
  {
    id: "baud_rate",
    header: "Baud rate (bps)",
    value: (row) => row.baud_rate ?? "—",
    cell: (row) => row.baud_rate?.toLocaleString("en-US") ?? "—",
    align: "right",
  },
  column("operating_mode", "Mode"),
  {
    id: "reverse",
    header: "Direction",
    value: (row) => (row.reverse ? "Reverse" : "Forward"),
  },
  column("position", "Position (pulse)"),
  angle("radians", "Motor angle"),
  angle("joint_radians", "Joint angle"),
  column("homing_offset", "Homing offset"),
  {
    id: "torque",
    header: "Torque",
    value: (row) => (row.torque ? "On" : "Off"),
  },
  column("hardware_error", "HW error"),
  column("status_return", "Return level"),
  column("current_ma", "Current (mA)"),
  column("voltage", "Voltage (V)"),
  column("temperature", "Temp. (°C)"),
];
const rowId = (row) => String(row.motor_id);
const directionChoices = [
  { value: "forward", label: "Forward" },
  { value: "reverse", label: "Reverse" },
];

export function DxlPage({ platform, active }) {
  const api = window.motorApp;
  const [ports, setPorts] = useState([]);
  const [port, setPort] = useState(platform === "linux" ? "/dev/ttyACM0" : "");
  const [baud, setBaud] = useState("1000000");
  const [activeBaud, setActiveBaud] = useState(null);
  const [connected, setConnected] = useState(false);
  const [faulted, setFaulted] = useState(false);
  const [fresh, setFresh] = useState(false);
  const [visible, setVisible] = useState(!document.hidden);
  const [motors, setMotors] = useState([]);
  const [selected, setSelected] = useState([]);
  const [newId, setNewId] = useState("");
  const [direction, setDirection] = useState("forward");
  const [confirm, setConfirm] = useState(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);
  const inProgress = useRef(false);
  const pollPending = useRef(false);
  const generation = useRef(0);
  const loadedPorts = useRef(false);
  const ids = selected.map(Number).sort((a, b) => a - b);
  const motorIds = motors.map((row) => row.motor_id).join(",");
  const canRead = connected && !busy;
  const hasSelection = canRead && ids.length > 0;
  const canWrite = active && visible && hasSelection && fresh && !faulted;
  const canConfirm = confirm?.operation === "torqueOff"
    ? active && visible && hasSelection
    : canWrite;
  const modeChanges = motors.filter(
    (row) => selected.includes(rowId(row)) && row.operating_mode !== 5,
  );

  function updateConnection(reply) {
    setConnected(reply.connected);
    setFaulted(reply.faulted);
    if (!reply.connected) {
      setMotors([]);
      setSelected([]);
      setFresh(false);
    }
  }

  async function run(operation, params = {}, done = () => {}) {
    if (inProgress.current) return;
    inProgress.current = true;
    generation.current += 1;
    setBusy(true);
    setNotice(null);
    try {
      if (operation === "openBackups") {
        await api.dxlBackups();
        return;
      }
      const reply = await api.dxl(operation, params);
      if (!reply) return;
      // Port listing is independent of the current connection.
      if (operation !== "ports") updateConnection(reply);
      if (reply.error) throw new Error(reply.error);
      done(reply.result);
    } catch (error) {
      if (!["ports", "openBackups", "authorize"].includes(operation)) {
        setFresh(false);
      }
      setNotice({ error: error.message });
    } finally {
      inProgress.current = false;
      setBusy(false);
    }
  }

  function listPorts() {
    return run("ports", {}, (result) => setPorts(result.ports));
  }

  useEffect(() => {
    if (active && !loadedPorts.current) {
      loadedPorts.current = true;
      void listPorts();
    }
  }, [active]);

  useEffect(() => {
    const updateVisibility = () => setVisible(!document.hidden);
    document.addEventListener("visibilitychange", updateVisibility);
    return () => document.removeEventListener("visibilitychange", updateVisibility);
  }, []);

  useLayoutEffect(() => {
    generation.current += 1;
    setFresh(false);
  }, [active, visible]);

  useEffect(() => {
    if (!active || !visible || !connected || !motorIds) return;
    async function poll() {
      if (inProgress.current || pollPending.current || document.hidden) return;
      const request = generation.current;
      pollPending.current = true;
      try {
        const reply = await api.dxl("poll", {
          ids: motorIds.split(",").map(Number),
        });
        if (request !== generation.current) return;
        updateConnection(reply);
        if (reply.error) throw new Error(reply.error);
        setMotors(reply.result.motors);
        setFresh(true);
      } catch (error) {
        if (request !== generation.current) return;
        setFresh(false);
        setConfirm((pending) => pending?.operation === "torqueOff" ? pending : null);
        setNotice({ error: error.message });
      } finally {
        pollPending.current = false;
      }
    }
    void poll();
    const timer = setInterval(poll, 1200);
    return () => clearInterval(timer);
  }, [active, api, connected, motorIds, visible]);

  function load(result, selectAll) {
    const available = result.motors.map(rowId);
    setMotors(result.motors);
    setSelected((previous) =>
      selectAll ? available : previous.filter((id) => available.includes(id)),
    );
    setFresh(true);
  }

  function write(operation, title, description, params = {}) {
    setConfirm({
      operation,
      title,
      description,
      action: () =>
        run(operation, { ids, ...params }, (result) => {
          if (operation === "set1Mbps") {
            load(result, true);
            setActiveBaud(result.baud);
            setBaud(String(result.baud));
            setNotice({
              message: `1 Mbps verified for ID ${ids[0]}.${result.path ? ` Backup saved to ${result.path}` : ""}`,
            });
            return;
          }
          if (operation === "setMode5") {
            const verified = new Map(
              result.motors.map((row) => [row.motor_id, row]),
            );
            setMotors((previous) =>
              previous.map((row) => verified.get(row.motor_id) ?? row),
            );
            const verifiedIds = result.motors
              .map((row) => row.motor_id)
              .join(", ");
            setNotice({
              message: `Mode 5 verified for IDs ${verifiedIds}.${result.path ? ` Backup saved to ${result.path}` : ""}`,
            });
            return;
          }
          if (result.motor) {
            const id = rowId(result.motor);
            setMotors((previous) =>
              previous
                .map((row) =>
                  row.motor_id === result.oldId ? result.motor : row,
                )
                .sort((a, b) => a.motor_id - b.motor_id),
            );
            setSelected([id]);
            setNewId("");
          }
          setNotice({
            message: result.path
              ? `Saved and verified. Backup: ${result.path}`
              : "Torque off verified.",
          });
        }),
    });
  }

  const newIdValue = /^[0-9]{1,3}$/.test(newId.trim()) ? Number(newId) : NaN;
  return (
    <section
      className="dxl-workspace"
      aria-label="Dynamixel setup"
      hidden={!active}
      aria-busy={busy}
    >
      {notice && (
        <Alert
          variant={notice.error ? "error" : "info"}
          role={notice.error ? "alert" : "status"}
        >
          <AlertDescription className="dxl-message">
            {notice.error || notice.message}
          </AlertDescription>
        </Alert>
      )}
      {faulted && (
        <Alert variant="error">
          <AlertDescription>
            Writes are locked. Disconnect and check the motor settings after
            reconnecting.
          </AlertDescription>
        </Alert>
      )}
      <Panel
        title="Dynamixel connection"
        description="XL330-M288-T and XL330-M077-T via a U2D2 TTL adapter."
      >
        <div className="dxl-row">
          <Field
            label="Serial port"
            value={port}
            list="dxl-port-list"
            placeholder={platform === "win32" ? "COM3" : "/dev/tty…"}
            onChange={(event) => setPort(event.target.value)}
            disabled={connected || busy}
          />
          <datalist id="dxl-port-list">
            {ports.map((device) => (
              <option key={device} value={device} />
            ))}
          </datalist>
          <Field
            label="Baud rate"
            inputMode="numeric"
            value={connected ? String(activeBaud) : baud}
            onChange={(event) => setBaud(event.target.value)}
            disabled={connected || busy}
          />
          <Button
            variant="outline"
            disabled={connected || busy}
            onClick={listPorts}
          >
            Refresh ports
          </Button>
          {platform === "linux" && (
            <Button
              variant="outline"
              disabled={
                connected ||
                busy ||
                !/^\/dev\/tty(?:ACM|USB)[0-9]+$/.test(port.trim())
              }
              onClick={() =>
                run("authorize", { port: port.trim() }, () =>
                  setNotice({
                    message: `Access ready for ${port.trim()}. Connect to continue.`,
                  }),
                )
              }
            >
              Grant port access
            </Button>
          )}
        </div>
        <div className="dxl-row">
          {connected ? (
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => run("disconnect")}
            >
              Disconnect
            </Button>
          ) : (
            <Button
              disabled={
                busy ||
                !port.trim() ||
                !/^[1-9][0-9]{0,7}$/.test(baud)
              }
              onClick={() =>
                run(
                  "connect",
                  { port: port.trim(), baud: Number(baud) },
                  (result) => {
                    load(result, true);
                    setActiveBaud(result.baud);
                    setNewId("");
                  },
                )
              }
            >
              Connect
            </Button>
          )}
          <Badge variant="outline">
            {connected ? "Hardware connected" : "Disconnected"}
          </Badge>
          {busy && <span role="status">Working…</span>}
        </div>
      </Panel>
      {connected && (
        <>
          <Panel
            title="Motors"
            action={<FreshnessIndicator quality={fresh ? "live" : "stale"} />}
          >
            <div className="dxl-row">
              <Button
                variant="outline"
                disabled={!canRead}
                onClick={() => run("scan", {}, (result) => load(result, false))}
              >
                Scan bus
              </Button>
              <Button
                variant="outline"
                disabled={!canRead || !motorIds}
                onClick={() =>
                  run(
                    "poll",
                    { ids: motorIds.split(",").map(Number) },
                    (result) => load(result, false),
                  )
                }
              >
                Refresh status
              </Button>
            </div>
            <DataTable
              data={motors}
              columns={columns}
              getRowId={rowId}
              caption="Dynamixel motors"
              selectable
              selectedIds={selected}
              onSelectionChange={(values) => {
                if (!inProgress.current) setSelected(values);
              }}
            />
          </Panel>
          <Panel
            title="EEPROM settings"
            description="Support the mechanism before turning torque off. Hold the reference pose while saving zero at 2048 pulses (0° joint angle)."
          >
            <div className="dxl-row">
              <Button
                variant="outline"
                disabled={!hasSelection}
                onClick={() =>
                  write(
                    "torqueOff",
                    "Turn torque off?",
                    `Support the mechanism first. Torque will be disabled for IDs ${ids.join(", ")}.`,
                  )
                }
              >
                Torque off
              </Button>
              <Button
                variant="outline"
                disabled={!canWrite || modeChanges.length === 0}
                onClick={() =>
                  write(
                    "setMode5",
                    "Set current-based position control?",
                    `Set Mode 5 for ${modeChanges.map((row) => `ID ${row.motor_id} (Mode ${row.operating_mode})`).join(", ")}. Torque must be off. The motor resets control settings, and the Min/Max Position Limits no longer apply.`,
                  )
                }
              >
                Set Mode 5
              </Button>
              <Button
                variant="outline"
                disabled={
                  !canWrite || ids.length !== 1 || activeBaud === 1_000_000
                }
                onClick={() =>
                  write(
                    "set1Mbps",
                    "Set 1 Mbps?",
                    `Connect only ID ${ids[0]} to the U2D2 and turn torque off. The app will save 1,000,000 bps and verify the motor at that speed.`,
                  )
                }
              >
                Set 1 Mbps
              </Button>
              <Button
                disabled={!canWrite}
                onClick={() =>
                  run("saveZero", { ids }, ({ path }) =>
                    setNotice({
                      message: `Zero saved and verified. Backup saved to ${path}`,
                    }),
                  )
                }
              >
                Save zero
              </Button>
            </div>
            <div className="dxl-row">
              <Field label="Direction">
                <Choice
                  value={direction}
                  options={directionChoices}
                  onChange={setDirection}
                  disabled={busy}
                />
              </Field>
              <Button
                variant="outline"
                disabled={!canWrite}
                onClick={() =>
                  write(
                    "direction",
                    "Save motor direction?",
                    `Set direction to ${direction} for IDs ${ids.join(", ")}.`,
                    { reverse: direction === "reverse" },
                  )
                }
              >
                Save direction
              </Button>
              <Field
                label="New ID"
                inputMode="numeric"
                value={newId}
                disabled={busy || ids.length !== 1}
                onChange={(event) => setNewId(event.target.value)}
              />
              <Button
                variant="outline"
                disabled={
                  !canWrite ||
                  ids.length !== 1 ||
                  !Number.isInteger(newIdValue) ||
                  newIdValue > 252 ||
                  newIdValue === ids[0]
                }
                onClick={() =>
                  write(
                    "setId",
                    "Change motor ID?",
                    `Change ID ${ids[0]} to ${newIdValue}. If motors share an ID, connect only one at a time.`,
                    { newId: newIdValue },
                  )
                }
              >
                Save ID
              </Button>
            </div>
          </Panel>
          <Panel title="Settings backups">
            <div className="dxl-row">
              <Button
                variant="outline"
                disabled={!hasSelection}
                onClick={() =>
                  run("export", { ids }, (result) =>
                    setNotice({ message: `Exported to ${result.path}` }),
                  )
                }
              >
                Export settings
              </Button>
              <Button
                variant="outline"
                disabled={!canWrite}
                onClick={() =>
                  write(
                    "restore",
                    "Restore zero and direction?",
                    `Choose a backup for IDs ${ids.join(", ")}. The selected motors keep their current IDs.`,
                  )
                }
              >
                Restore zero and direction
              </Button>
              <Button
                variant="ghost"
                disabled={busy}
                onClick={() => run("openBackups")}
              >
                Open backup folder
              </Button>
            </div>
          </Panel>
        </>
      )}
      <Dialog
        open={Boolean(confirm)}
        onOpenChange={(open) => {
          if (!open) setConfirm(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{confirm?.title}</DialogTitle>
            <DialogDescription>{confirm?.description}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirm(null)}>
              Cancel
            </Button>
            <Button
              disabled={!canConfirm}
              onClick={() => {
                if (!confirm || !canConfirm || document.hidden) return;
                const action = confirm.action;
                setConfirm(null);
                void action();
              }}
            >
              Confirm
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
