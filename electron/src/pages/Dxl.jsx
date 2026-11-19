import { message, messageText } from "../../i18n.mjs";
import { formatLocale } from "../language.mjs";
import { useTranslation } from "react-i18next";
import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Alert, AlertDescription } from "@motomindkr/ui/components/alert";
import { Cable, RefreshCw, Search } from "lucide-react";
import {
  Combobox,
  ComboboxInput,
  ComboboxContent,
  ComboboxList,
  ComboboxEmpty,
  ComboboxItem,
} from "@motomindkr/ui/components/combobox";
import { Field as UIField, FieldLabel } from "@motomindkr/ui/components/field";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@motomindkr/ui/components/item";
import { Badge } from "@motomindkr/ui/components/badge";
import { Spinner } from "@motomindkr/ui/components/spinner";
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

function motorColumns(t, locale) {
  const angleFormat = (digits) =>
    new Intl.NumberFormat(locale, {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    });
  const radians = angleFormat(3),
    degrees = angleFormat(1);
  return [
    { id: "motor_id", header: t("ID"), value: (row) => row.motor_id },
    {
      id: "name",
      header: t("Model"),
      value: (row) => row.name,
      cell: (row) =>
        row.hardware_error ? (
          <>
            {row.name}{" "}
            <Badge variant="error">
              {t("Hardware error {{code}}", { code: row.hardware_error })}
            </Badge>
          </>
        ) : (
          row.name
        ),
    },
    {
      id: "operating_mode",
      header: t("Mode"),
      value: (row) => row.operating_mode,
    },
    {
      id: "position",
      header: t("Position (pulse)"),
      value: (row) => row.position,
      align: "right",
    },
    {
      id: "joint_radians",
      header: t("Joint angle"),
      value: (row) => row.joint_radians,
      align: "right",
      cell: (row) =>
        `${radians.format(row.joint_radians)} rad / ${degrees.format(row.joint_degrees)}°`,
    },
    {
      id: "torque",
      header: t("Torque"),
      value: (row) => (row.torque ? t("On") : t("Off")),
    },
  ];
}

function MotorDetails({ motor }) {
  const { t } = useTranslation();
  const readings = [
    [t("Firmware"), motor.firmware],
    [t("Baud rate (bps)"), motor.baud_rate?.toLocaleString(formatLocale)],
    [t("Direction"), motor.reverse ? t("Reverse") : t("Forward")],
    [
      t("Motor angle"),
      `${motor.radians.toLocaleString(formatLocale, { maximumFractionDigits: 3 })} rad / ${motor.degrees.toLocaleString(formatLocale, { maximumFractionDigits: 1 })}°`,
    ],
    [t("Homing offset"), motor.homing_offset],
    [t("HW error"), motor.hardware_error],
    [t("Return level"), motor.status_return],
    [t("Current (mA)"), motor.current_ma],
    [t("Voltage (V)"), motor.voltage],
    [t("Temp. (°C)"), motor.temperature],
  ];
  return (
    <dl className="dxl-readings">
      {readings.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value ?? "—"}</dd>
        </div>
      ))}
    </dl>
  );
}
const rowId = (row) => String(row.motor_id);
const directionChoices = [
  { value: "forward", label: "Forward" },
  { value: "reverse", label: "Reverse" },
];

export function DxlPage({ platform, active }) {
  const { t } = useTranslation();
  const columns = React.useMemo(
    () => motorColumns(t, formatLocale),
    [t, formatLocale],
  );
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
  const canConfirm =
    confirm?.operation === "torqueOff"
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
    return () =>
      document.removeEventListener("visibilitychange", updateVisibility);
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
        setConfirm((pending) =>
          pending?.operation === "torqueOff" ? pending : null,
        );
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
              message: message("1 Mbps verified for ID {{id}}.", {
                id: ids[0],
              }),
              backup: result.path,
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
              message: message("Mode 5 verified for IDs {{ids}}.", {
                ids: verifiedIds,
              }),
              backup: result.path,
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
              ? message("Saved and verified. Backup: {{path}}", {
                  path: result.path,
                })
              : "Torque off verified.",
          });
        }),
    });
  }

  const connectionStatus = (
    <Badge role="status" variant={connected ? "success" : "secondary"}>
      {busy && <Spinner aria-hidden="true" />}
      {busy
        ? t("Working…")
        : connected
          ? t("Hardware connected")
          : t("Disconnected")}
    </Badge>
  );
  const newIdValue = /^[0-9]{1,3}$/.test(newId.trim()) ? Number(newId) : NaN;
  return (
    <section
      className="stack dxl-workspace"
      aria-label={t("Dynamixel setup")}
      hidden={!active}
      aria-busy={busy}
    >
      {notice && (
        <Alert
          variant={notice.error ? "error" : "info"}
          role={notice.error ? "alert" : "status"}
        >
          <AlertDescription className="dxl-message">
            {notice.error || messageText(notice.message)}
            {notice.backup && (
              <div>
                {t("Backup saved to {{path}}", { path: notice.backup })}
              </div>
            )}
          </AlertDescription>
        </Alert>
      )}
      {faulted && (
        <Alert variant="error">
          <AlertDescription>
            {t(
              "Writes are locked. Disconnect and check the motor settings after reconnecting.",
            )}
          </AlertDescription>
        </Alert>
      )}
      {connected ? (
        <Item variant="outline">
          <ItemMedia variant="icon">
            <Cable />
          </ItemMedia>
          <ItemContent>
            <ItemTitle>
              <h2>{t("Dynamixel connection")}</h2>
            </ItemTitle>
            <ItemDescription>
              {port.trim()} · {activeBaud?.toLocaleString(formatLocale)} bps
            </ItemDescription>
          </ItemContent>
          <ItemActions>
            {connectionStatus}
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => run("disconnect")}
            >
              {t("Disconnect")}
            </Button>
          </ItemActions>
        </Item>
      ) : (
        <Panel
          title={t("Dynamixel connection")}
          description={t(
            "XL330-M288-T and XL330-M077-T via a U2D2 TTL adapter.",
          )}
          action={connectionStatus}
        >
          <div className="dxl-connection">
            <UIField>
              <FieldLabel htmlFor="dxl-port">{t("Serial port")}</FieldLabel>
              <Combobox
                items={ports}
                value={port || null}
                inputValue={port}
                onInputValueChange={setPort}
                onValueChange={(value) => {
                  if (value) setPort(value);
                }}
                disabled={busy}
              >
                <ComboboxInput
                  id="dxl-port"
                  disabled={busy}
                  placeholder={platform === "win32" ? "COM3" : "/dev/tty…"}
                />
                <ComboboxContent>
                  <ComboboxEmpty>
                    {t("No matching ports. Enter a port name to connect.")}
                  </ComboboxEmpty>
                  <ComboboxList>
                    {(device) => (
                      <ComboboxItem key={device} value={device}>
                        {device}
                      </ComboboxItem>
                    )}
                  </ComboboxList>
                </ComboboxContent>
              </Combobox>
            </UIField>
            <Field
              label={t("Baud rate")}
              inputMode="numeric"
              value={baud}
              onChange={(event) => setBaud(event.target.value)}
              disabled={busy}
            />
            <div className="dxl-actions">
              <Button
                disabled={
                  busy || !port.trim() || !/^[1-9][0-9]{0,7}$/.test(baud)
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
                {t("Connect")}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={listPorts}
              >
                <RefreshCw />
                {t("Refresh ports")}
              </Button>
              {platform === "linux" && (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={
                    busy || !/^\/dev\/tty(?:ACM|USB)[0-9]+$/.test(port.trim())
                  }
                  onClick={() =>
                    run("authorize", { port: port.trim() }, () =>
                      setNotice({
                        message: message(
                          "Access ready for {{port}}. Connect to continue.",
                          { port: port.trim() },
                        ),
                      }),
                    )
                  }
                >
                  {t("Grant port access")}
                </Button>
              )}
            </div>
          </div>
        </Panel>
      )}
      {connected && (
        <>
          <Panel
            title={t("Motors")}
            action={
              <div className="dxl-actions">
                <FreshnessIndicator quality={fresh ? "live" : "stale"} />
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!canRead}
                  onClick={() =>
                    run("scan", {}, (result) => load(result, false))
                  }
                >
                  <Search />
                  {t("Scan bus")}
                </Button>
              </div>
            }
          >
            <DataTable
              data={motors}
              columns={columns}
              getRowId={rowId}
              caption={t("Dynamixel motors")}
              renderExpanded={(row) => <MotorDetails motor={row} />}
              labels={{
                filter: t("Filter motors"),
                empty: t("No results."),
                selectAll: t("Select all filtered rows"),
                selectRow: t("Select"),
                details: t("Details"),
                rows: t("rows"),
                selected: t("selected"),
                scrollArea: t("Dynamixel motors"),
              }}
              selectable
              selectedIds={selected}
              onSelectionChange={(values) => {
                if (!inProgress.current) setSelected(values);
              }}
            />
          </Panel>
          <Panel
            title={t("EEPROM settings")}
            description={t(
              "Support the mechanism before turning torque off. Hold the reference pose while saving zero at 2048 pulses (0° joint angle).",
            )}
          >
            <div className="dxl-actions">
              <Button
                variant="outline"
                disabled={!hasSelection}
                onClick={() =>
                  write(
                    "torqueOff",
                    t("Turn torque off?"),
                    t(
                      "Support the mechanism first. Torque will be disabled for IDs {{ids}}.",
                      { ids: ids.join(", ") },
                    ),
                  )
                }
              >
                {t("Torque off")}
              </Button>
              <Button
                variant="outline"
                disabled={!canWrite || modeChanges.length === 0}
                onClick={() =>
                  write(
                    "setMode5",
                    t("Set current-based position control?"),
                    t(
                      "Set Mode 5 for {{motors}}. Torque must be off. The motor resets control settings, and the Min/Max Position Limits no longer apply.",
                      {
                        motors: modeChanges
                          .map((row) =>
                            t("ID {{id}} (Mode {{mode}})", {
                              id: row.motor_id,
                              mode: row.operating_mode,
                            }),
                          )
                          .join(", "),
                      },
                    ),
                  )
                }
              >
                {t("Set Mode 5")}
              </Button>
              <Button
                variant="outline"
                disabled={
                  !canWrite || ids.length !== 1 || activeBaud === 1_000_000
                }
                onClick={() =>
                  write(
                    "set1Mbps",
                    t("Set 1 Mbps?"),
                    t(
                      "Connect only ID {{id}} to the U2D2 and turn torque off. The app will save 1,000,000 bps and verify the motor at that speed.",
                      { id: ids[0] },
                    ),
                  )
                }
              >
                {t("Set 1 Mbps")}
              </Button>
              <Button
                disabled={!canWrite}
                onClick={() =>
                  run("saveZero", { ids }, ({ path }) =>
                    setNotice({
                      message: message(
                        "Zero saved and verified. Backup saved to {{path}}",
                        { path },
                      ),
                    }),
                  )
                }
              >
                {t("Save zero")}
              </Button>
            </div>
            <div className="dxl-edits">
              <div className="dxl-edit">
                <Field label={t("Direction")}>
                  <Choice
                    value={direction}
                    options={directionChoices.map((choice) => ({
                      ...choice,
                      label: t(choice.label),
                    }))}
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
                      t("Save motor direction?"),
                      t("Set direction to {{direction}} for IDs {{ids}}.", {
                        direction:
                          direction === "reverse" ? t("Reverse") : t("Forward"),
                        ids: ids.join(", "),
                      }),
                      { reverse: direction === "reverse" },
                    )
                  }
                >
                  {t("Save direction")}
                </Button>
              </div>
              <div className="dxl-edit">
                <Field
                  label={t("New ID")}
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
                      t("Change motor ID?"),
                      t(
                        "Change ID {{id}} to {{newId}}. If motors share an ID, connect only one at a time.",
                        { id: ids[0], newId: newIdValue },
                      ),
                      { newId: newIdValue },
                    )
                  }
                >
                  {t("Save ID")}
                </Button>
              </div>
            </div>
          </Panel>
          <Panel title={t("Settings backups")}>
            <div className="dxl-actions">
              <Button
                variant="outline"
                disabled={!hasSelection}
                onClick={() =>
                  run("export", { ids }, (result) =>
                    setNotice({
                      message: message("Exported to {{path}}", {
                        path: result.path,
                      }),
                    }),
                  )
                }
              >
                {t("Export settings")}
              </Button>
              <Button
                variant="outline"
                disabled={!canWrite}
                onClick={() =>
                  write(
                    "restore",
                    t("Restore zero and direction?"),
                    t(
                      "Choose a backup for IDs {{ids}}. The selected motors keep their current IDs.",
                      { ids: ids.join(", ") },
                    ),
                  )
                }
              >
                {t("Restore zero and direction")}
              </Button>
              <Button
                variant="ghost"
                disabled={busy}
                onClick={() => run("openBackups")}
              >
                {t("Open backup folder")}
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
              {t("Cancel")}
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
              {t("Confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
