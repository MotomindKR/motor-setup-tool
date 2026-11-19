import React from "react";
import {
  ArrowDownToLine,
  ArrowUpRight,
  Cable,
  ChevronRight,
  Cpu,
  RefreshCw,
  Search,
  Target,
  Upload,
} from "lucide-react";
import { Badge } from "@motomindkr/ui/components/badge";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@motomindkr/ui/components/input-group";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@motomindkr/ui/components/table";
import {
  Panel,
  Field,
  Choice,
  Button,
  Empty,
  Disclosure,
  NumericInput,
} from "../ui.jsx";
import { numberText, registerValueText } from "../controller.mjs";
import { conciseNumber } from "../format.mjs";

function RegisterPanel({ s, a, c }) {
  const access = (r) =>
    r.availability === "not_documented"
      ? "Not documented"
      : r.readable
        ? r.writable
          ? "Read / write"
          : "Read only"
        : "Write only";
  const storage = (r) =>
    r.persistence === "save_to_flash"
      ? "Persistent · save required"
      : r.persistence === "volatile"
        ? "Live · not stored"
        : "Persistence undocumented";
  const registers = s.registers.filter((r) =>
    `${r.name} ${r.symbol} 0x${r.index.toString(16)} ${r.host_index || ""}`
      .toLowerCase()
      .includes(s.registerSearch.trim().toLowerCase()),
  );
  const r = s.registers.find((r) => r.index === s.registerIndex);
  return (
    <Panel
      title="Motor registers"
      className="register-panel"
      action={
        <Badge variant="secondary">
          {registers.length} registers
        </Badge>
      }
    >
      <InputGroup className="register-search">
        <InputGroupAddon>
          <Search aria-hidden="true" />
        </InputGroupAddon>
        <InputGroupInput
          aria-label="Search registers"
          type="search"
          placeholder="Search name, symbol, or address…"
          value={s.registerSearch}
          onChange={(e) => a.searchRegisters(e.target.value)}
        />
      </InputGroup>
      <div className="register-workspace">
        <div className="register-list">
          <Table aria-label="Registers">
            <TableHeader>
              <TableRow>
                <TableHead>Address</TableHead>
                <TableHead>Register</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {registers.map((item) => (
                <TableRow
                  key={item.index}
                  data-state={
                    item.index === s.registerIndex ? "selected" : undefined
                  }
                >
                  <TableCell>
                    <code>0x{item.index.toString(16).toUpperCase()}</code>
                  </TableCell>
                  <TableCell>
                    <Button
                      variant="ghost"
                      className="register-select"
                      aria-pressed={item.index === s.registerIndex}
                      disabled={c.busy}
                      onClick={() => a.selectRegister(item.index)}
                    >
                      <span>
                        {item.name}
                        <small>
                          {item.symbol}
                          {` · ${access(item)}${item.writable && !item.editable ? " · Protected" : ""}`}
                        </small>
                      </span>
                      <ChevronRight />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {!registers.length && (
            <p className="field-hint no-registers">No matching registers.</p>
          )}
        </div>
        <div className="register-editor">
          <h3>{r?.name || "Select a register"}</h3>
          <p className="register-meta">
            {r &&
              `0x${r.index.toString(16).toUpperCase()} · ${r.value_type} · ${access(r)}`}
          </p>
          {r && (
            <p className="field-hint">
              {storage(r)}
              {r.host_index ? ` · Host code ${r.host_index}` : ""}
            </p>
          )}
          {r?.description && <p>{r.description}</p>}
          <div className="register-current">
            <div>
              <span>Current value</span>
              <strong>
                {s.registerRead
                  ? registerValueText(s.registerRead.value, r)
                  : "—"}
              </strong>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={a.readRegister}
              disabled={!c.registerRead}
            >
              <RefreshCw />
              Read
            </Button>
          </div>
          {r?.editable ? (
            <>
              <Field
                label="New value"
                hint={
                  r?.editable
                    ? `${conciseNumber(r.min)} to ${conciseNumber(r.max)}`
                    : "Read only"
                }
              >
                {r?.choices?.length ? (
                  <Choice
                    value={s.registerValue}
                    onChange={a.setRegisterValue}
                    options={r.choices.map((ch) => ({
                      value: String(ch.value),
                      label: ch.label,
                    }))}
                    disabled={
                      !s.registerRead || !r?.editable || c.busy || !c.motor
                    }
                    placeholder="Read first"
                  />
                ) : (
                  <NumericInput
                    min={r?.min}
                    max={r?.max}
                    step="any"
                    placeholder="Read first"
                    value={s.registerValue}
                    onValueChange={a.setRegisterValue}
                    disabled={
                      !s.registerRead || !r?.editable || c.busy || !c.motor
                    }
                  />
                )}
              </Field>
              <Button
                className="full"
                disabled={!c.registerWrite}
                onClick={a.writeRegister}
              >
                <ArrowDownToLine />
                Save to motor
              </Button>
              <p className="field-hint" role="status">
                {s.registerMessage ||
                  (!s.registerRead ? "Read to edit." : "")}
              </p>
            </>
          ) : (
            <p className="field-hint">
              {r?.protected_reason ||
                (r?.readable ? "Read only" : "Readback unavailable")}
            </p>
          )}
        </div>
      </div>
    </Panel>
  );
}
export function SetupPage({ s, a, c }) {
  if (!c.motor)
    return (
      <Empty compact icon={Cable} title="No motor selected">
        Scan above to open motor settings.
      </Empty>
    );
  const blocked = c.busy || !c.motor;
  const spec = s.preview?.spec;
  return (
    <div className="stack">
      <div className="setup-grid">
        <Panel title="Position reference" size="md">
          <div className="reference-grid">
            <Field
              label="Display angle"
              type="number"
              step="any"
              min={s.referenceUnit === "deg" ? (-100 * 180) / Math.PI : -100}
              max={s.referenceUnit === "deg" ? (100 * 180) / Math.PI : 100}
              value={s.referenceInput}
              onValueChange={a.setReferenceInput}
              disabled={blocked}
            />
            <Field label="Unit">
              <Choice
                value={s.referenceUnit}
                onChange={a.setReferenceUnit}
                options={[
                  { value: "rad", label: "Radians" },
                  { value: "deg", label: "Degrees" },
                ]}
                disabled={blocked}
              />
            </Field>
          </div>
          <Button
            className="full"
            variant="outline"
            disabled={blocked}
            onClick={() => a.zero()}
          >
            <Target />
            Set current position
          </Button>
          <p className="field-hint">Sets motor zero to 0 at this position.</p>
        </Panel>
        <Panel title="Motor identity" size="md">
          <div className="identity-current">
            <span>Current motor ID</span>
            <strong>{s.motor?.id ?? "—"}</strong>
          </div>
          <Field
            label="New motor ID"
            type="number"
            min="1"
            max="254"
            placeholder="1–254"
            value={s.newId}
            onValueChange={a.setNewId}
            disabled={blocked}
          />
          <Button
            className="full"
            variant="outline"
            onClick={a.changeId}
            disabled={
              blocked ||
              !s.newId.trim() ||
              !Number.isInteger(Number(s.newId)) ||
              Number(s.newId) < 1 ||
              Number(s.newId) > 254 ||
              Number(s.newId) === s.motor?.id ||
              Number(s.newId) === Number(s.connection.hostId)
            }
          >
            <Cpu />
            Change ID
          </Button>
        </Panel>
        <Panel title="Firmware" size="md">
          <div className="identity-current">
            <span>Installed version</span>
            <strong className="firmware-version">
              {s.motor?.firmware || "—"}
            </strong>
          </div>
          <Button
            className="full"
            variant="outline"
            disabled={blocked}
            onClick={a.prepareFirmware}
          >
            <ArrowDownToLine />
            Download and verify
          </Button>
          {s.firmwareMessage && (
            <p className="field-hint" role="status">
              {s.firmwareMessage}
            </p>
          )}
          <div className="firmware-actions">
            <Button variant="link" size="sm" onClick={a.releaseNotes}>
              Release notes
              <ArrowUpRight />
            </Button>
            <Button
              variant="destructive"
              size="sm"
              disabled={blocked || !s.firmware || s.firmware.id !== s.motor?.id}
              onClick={a.updateFirmware}
            >
              <Upload />
              Update firmware
            </Button>
          </div>
        </Panel>
      </div>
      {s.registers && <RegisterPanel s={s} a={a} c={c} />}
      <Disclosure
        className="disclosure motor-specs"
        title="Motor specifications & CAN protocol"
      >
        <div className="spec-grid">
          <p>
            {spec
              ? `${spec.rated_torque} Nm rated · ${spec.peak_torque} Nm peak · ${spec.no_load_rpm} rpm · ${spec.gear_ratio}:1 · ${spec.rated_voltage} V`
              : "Select a motor to view its specifications."}
          </p>
          <p>
            {s.preset
              ? `Host ID ${s.connection.hostId} · position ±${numberText(s.preset.profile.position_range)} rad · speed ±${numberText(s.preset.profile.velocity_range, 2)} rad/s · torque ±${numberText(s.preset.profile.torque_range, 2)} Nm`
              : "Protocol details appear after a motor is selected."}
          </p>
        </div>
      </Disclosure>
    </div>
  );
}
