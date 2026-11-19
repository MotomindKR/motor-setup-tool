import { messageText } from "../i18n.mjs";
import { useTranslation } from "react-i18next";
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
import { registerValueText } from "../controller.mjs";
import { conciseNumber, displayAngle, numberText } from "../format.mjs";

function RegisterPanel({ s, a, c }) {
  const { t } = useTranslation();
  const access = (r) =>
    r.availability === "not_documented"
      ? t("Not documented")
      : r.readable
        ? r.writable
          ? t("Read / write")
          : t("Read only")
        : t("Write only");
  const storage = (r) =>
    r.persistence === "save_to_flash"
      ? t("Persistent · save required")
      : r.persistence === "volatile"
        ? t("Live · not stored")
        : t("Persistence undocumented");
  const registers = s.registers.filter((r) =>
    `${r.name} ${t(r.name)} ${r.symbol} 0x${r.index.toString(16)} ${r.host_index || ""}`
      .toLowerCase()
      .includes(s.registerSearch.trim().toLowerCase()),
  );
  const r = s.registers.find((r) => r.index === s.registerIndex);
  return (
    <Panel
      title={t("Motor registers")}
      className="register-panel"
      action={
        <Badge variant="secondary">
          {t("{{count}} registers", { count: registers.length })}
        </Badge>
      }
    >
      <InputGroup className="register-search">
        <InputGroupAddon>
          <Search aria-hidden="true" />
        </InputGroupAddon>
        <InputGroupInput
          aria-label={t("Search registers")}
          type="search"
          placeholder={t("Search name, symbol, or address…")}
          value={s.registerSearch}
          onChange={(e) => a.searchRegisters(e.target.value)}
        />
      </InputGroup>
      <div className="register-workspace">
        <div className="register-list">
          <Table aria-label={t("Registers")}>
            <TableHeader>
              <TableRow>
                <TableHead>{t("Address")}</TableHead>
                <TableHead>{t("Register")}</TableHead>
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
                        {t(item.name)}
                        <small>
                          {item.symbol}
                          {` · ${access(item)}${item.writable && !item.editable ? t(" · Protected") : ""}`}
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
            <p className="field-hint no-registers">{t("No matching registers.")}</p>
          )}
        </div>
        <div className="register-editor">
          <h3>{r ? t(r.name) : t("Select a register")}</h3>
          <p className="register-meta">
            {r &&
              `0x${r.index.toString(16).toUpperCase()} · ${r.value_type} · ${access(r)}`}
          </p>
          {r && (
            <p className="field-hint">
              {storage(r)}
              {r.host_index ? t(" · Host code {{code}}", { code: r.host_index }) : ""}
            </p>
          )}
          {r?.description && <p>{t(r.description)}</p>}
          <div className="register-current">
            <div>
              <span>{t("Current value")}</span>
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
              {t("Read")}
            </Button>
          </div>
          {r?.editable ? (
            <>
              <Field
                label={t("New value")}
                hint={t("{{min}} to {{max}}", { min: conciseNumber(r.min), max: conciseNumber(r.max) })}
              >
                {r?.choices?.length ? (
                  <Choice
                    value={s.registerValue}
                    onChange={a.setRegisterValue}
                    options={r.choices.map((ch) => ({
                      value: String(ch.value),
                      label: t(ch.label),
                    }))}
                    disabled={!s.registerRead || c.busy}
                    placeholder={t("Read first")}
                  />
                ) : (
                  <NumericInput
                    min={r?.min}
                    max={r?.max}
                    step="any"
                    placeholder={t("Read first")}
                    value={s.registerValue}
                    onValueChange={a.setRegisterValue}
                    disabled={!s.registerRead || c.busy}
                  />
                )}
              </Field>
              <Button
                className="full"
                disabled={!c.registerWrite}
                onClick={a.writeRegister}
              >
                <ArrowDownToLine />
                {t("Save to motor")}
              </Button>
              <p className="field-hint" role="status">
                {messageText(s.registerMessage) ||
                  (!s.registerRead ? t("Read to edit.") : "")}
              </p>
            </>
          ) : (
            <p className="field-hint">
              {r?.protected_reason ? t(r.protected_reason) :
                (r?.readable ? t("Read only") : t("Readback unavailable"))}
            </p>
          )}
        </div>
      </div>
    </Panel>
  );
}
export function SetupPage({ s, a, c }) {
  const { t } = useTranslation();
  if (!c.motor)
    return (
      <Empty compact icon={Cable} title={t("No motor selected")}>
        {t("Scan above to open motor settings.")}
      </Empty>
    );
  const spec = s.preview?.spec;
  return (
    <div className="stack">
      <div className="setup-grid">
        <Panel title={t("Position reference")} size="md">
          <div className="reference-grid">
            <Field
              label={t("Display angle")}
              type="number"
              step="any"
              min={displayAngle(-100, s.referenceUnit)}
              max={displayAngle(100, s.referenceUnit)}
              value={s.referenceInput}
              onValueChange={a.setReferenceInput}
              disabled={c.busy}
            />
            <Field label={t("Unit")}>
              <Choice
                value={s.referenceUnit}
                onChange={a.setReferenceUnit}
                options={[
                  { value: "rad", label: t("Radians") },
                  { value: "deg", label: t("Degrees") },
                ]}
                disabled={c.busy}
              />
            </Field>
          </div>
          <Button
            className="full"
            variant="outline"
            disabled={c.busy}
            onClick={() => a.zero()}
          >
            <Target />
            {t("Set current position")}
          </Button>
          <p className="field-hint">{t("Sets motor zero to 0 at this position.")}</p>
        </Panel>
        <Panel title={t("Motor identity")} size="md">
          <div className="identity-current">
            <span>{t("Current motor ID")}</span>
            <strong>{s.motor?.id ?? "—"}</strong>
          </div>
          <Field
            label={t("New motor ID")}
            type="number"
            min="1"
            max="254"
            placeholder="1–254"
            value={s.newId}
            onValueChange={a.setNewId}
            disabled={c.busy}
          />
          <Button
            className="full"
            variant="outline"
            onClick={a.changeId}
            disabled={!c.changeId}
          >
            <Cpu />
            {t("Change ID")}
          </Button>
        </Panel>
        <Panel title={t("Firmware")} size="md">
          <div className="identity-current">
            <span>{t("Installed version")}</span>
            <strong className="firmware-version">
              {s.motor?.firmware || "—"}
            </strong>
          </div>
          <Button
            className="full"
            variant="outline"
            disabled={c.busy}
            onClick={a.prepareFirmware}
          >
            <ArrowDownToLine />
            {t("Download and verify")}
          </Button>
          {s.firmwareMessage && (
            <p className="field-hint" role="status">
              {messageText(s.firmwareMessage)}
            </p>
          )}
          <div className="firmware-actions">
            <Button variant="link" size="sm" onClick={a.releaseNotes}>
              {t("Release notes")}
              <ArrowUpRight />
            </Button>
            <Button
              variant="destructive"
              size="sm"
              disabled={!c.updateFirmware}
              onClick={a.updateFirmware}
            >
              <Upload />
              {t("Update firmware")}
            </Button>
          </div>
        </Panel>
      </div>
      {s.registers && <RegisterPanel s={s} a={a} c={c} />}
      <Disclosure
        className="disclosure motor-specs"
        title={t("Motor specifications & CAN protocol")}
      >
        <div className="spec-grid">
          <p>
            {spec
              ? t("{{rated}} Nm rated · {{peak}} Nm peak · {{speed}} rpm · {{ratio}}:1 · {{voltage}} V", { rated: spec.rated_torque, peak: spec.peak_torque, speed: spec.no_load_rpm, ratio: spec.gear_ratio, voltage: spec.rated_voltage })
              : t("Select a motor to view its specifications.")}
          </p>
          <p>
            {s.preset
              ? t("Host ID {{id}} · position ±{{position}} rad · speed ±{{speed}} rad/s · torque ±{{torque}} Nm", { id: s.connection.hostId, position: numberText(s.preset.profile.position_range), speed: numberText(s.preset.profile.velocity_range, 2), torque: numberText(s.preset.profile.torque_range, 2) })
              : t("Protocol details appear after a motor is selected.")}
          </p>
        </div>
      </Disclosure>
    </div>
  );
}
