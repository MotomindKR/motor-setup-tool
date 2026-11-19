"""Motor configuration, with checked writes and pre-write backup journals."""
from __future__ import annotations

from dataclasses import asdict, dataclass, replace
from datetime import datetime, timezone
import json
from math import tau
from pathlib import Path
import time
from uuid import uuid4

from .messages import translate
from .transport import (
    BAUD_RATE_ADDRESS, BAUD_RATES, CURRENT_BASED_POSITION_MODE, OPERATING_MODE_ADDRESS,
    TARGET_BAUD, TARGET_BAUD_CODE, DeviceError, Transport, signed,
)

MODELS = {1200: "XL330-M288-T", 1190: "XL330-M077-T"}
POSITION_MODES = (3, 4, CURRENT_BASED_POSITION_MODE)
SETTING_FIELDS = {10: "drive_mode", OPERATING_MODE_ADDRESS: "operating_mode", 20: "homing_offset"}
DEFAULT_ZERO_PULSE = 2048
TOLERANCE = 8  # ~0.70 degrees at motor output; pose must stay within this window.


class NoSupportedMotors(DeviceError):
    pass


@dataclass(frozen=True)
class MotorState:
    motor_id: int
    model: int
    firmware: int
    drive_mode: int
    operating_mode: int
    homing_offset: int
    min_position: int
    max_position: int
    torque: int
    status_return: int
    hardware_error: int
    position: int
    current_ma: int
    voltage: float
    temperature: int
    baud_code: int

    @property
    def baud_rate(self) -> int | None:
        return BAUD_RATES[self.baud_code] if 0 <= self.baud_code < len(BAUD_RATES) else None

    @property
    def name(self) -> str:
        return MODELS.get(self.model) or translate("Unsupported model ({model})", model=self.model)

    @property
    def reverse(self) -> bool:
        return bool(self.drive_mode & 1)

    @property
    def radians(self) -> float:
        return self.position * tau / 4096

    @property
    def degrees(self) -> float:
        return self.position * 360 / 4096

    @property
    def joint_radians(self) -> float:
        return (self.position - DEFAULT_ZERO_PULSE) * tau / 4096

    @property
    def joint_degrees(self) -> float:
        return (self.position - DEFAULT_ZERO_PULSE) * 360 / 4096


@dataclass(frozen=True)
class IdChangeResult:
    old_id: int
    state: MotorState
    backup_path: Path


def validate_offset(mode: int, value: int) -> None:
    if mode not in POSITION_MODES:
        raise DeviceError("Calibration requires position mode 3, 4, or 5. Current mode: {mode}.", mode=mode)
    limit = 1024 if mode == 3 else 1_044_479
    if type(value) is not int or not -limit <= value <= limit:
        raise DeviceError(
            "Homing offset {value} exceeds the range for mode {mode} (±{limit}).",
            mode=mode,
            value=value,
            limit=limit,
        )


def validate_zero_mode(state: MotorState) -> None:
    # Preserve the existing 2048 calibration support without changing motor mode.
    validate_offset(state.operating_mode, 0)


def zero_offset(state: MotorState) -> int:
    # Reverse inverts the reported position's response to the stored offset.
    # Observed on XL330 firmware 53 in Mode 5; always verify position after writing.
    correction = DEFAULT_ZERO_PULSE - state.position
    return state.homing_offset + (-correction if state.reverse else correction)


def atomic_json(path: Path, data: dict) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{uuid4().hex}.tmp")
    try:
        with temporary.open("x", encoding="utf-8") as stream:
            json.dump(data, stream, ensure_ascii=False, indent=2, allow_nan=False)
            stream.write("\n")
            stream.flush()
            import os
            os.fsync(stream.fileno())
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


class SettingsService:
    """Call from a single serialized worker; no internal polling or motion."""

    def __init__(self, transport: Transport, backup_dir: Path):
        self.transport = transport
        self.backup_dir = Path(backup_dir)
        self.faulted = False

    def close(self) -> None:
        self.transport.close()

    def _read_supported_model(self, motor_id: int) -> int:
        if type(motor_id) is not int or not 0 <= motor_id <= 252:
            raise DeviceError("Choose a motor ID from 0 to 252.")
        model = self.transport.read(motor_id, 0, 2)
        if model not in MODELS:
            # Do not interpret unknown models with the XL330 register map.
            raise DeviceError("ID {motor_id}: unsupported model {model}", motor_id=motor_id, model=model)
        return model

    def read_state(self, motor_id: int) -> MotorState:
        model = self._read_supported_model(motor_id)
        r = lambda address, size=1: self.transport.read(motor_id, address, size)
        return MotorState(
            motor_id, model, r(6), r(10), r(OPERATING_MODE_ADDRESS), signed(r(20, 4), 32),
            r(52, 4), r(48, 4), r(64), r(68), r(70),
            signed(r(132, 4), 32), signed(r(126, 2), 16), r(144, 2) / 10, r(146),
            baud_code=r(BAUD_RATE_ADDRESS),
        )

    def read_states(self, ids) -> tuple[MotorState, ...]:
        ids = tuple(ids)
        if not ids or len(ids) != len(set(ids)):
            raise DeviceError("Select at least one motor. Each ID must be unique.")
        return tuple(self.read_state(i) for i in ids)

    def scan(self) -> tuple[MotorState, ...]:
        devices = self.transport.scan()
        ids = sorted(i for i, model in devices.items() if model in MODELS)
        if not ids:
            raise NoSupportedMotors("No XL330-M288-T or XL330-M077-T found. Check the port, baud rate, and motor power.")
        return self.read_states(ids)

    def _editable(self, states) -> None:
        if self.faulted:
            raise DeviceError("Writes are locked. Reconnect and read the motor settings.")
        for state in states:
            if state.torque != 0:
                raise DeviceError(
                    "ID {motor_id}: support the mechanism and turn torque off before saving.",
                    motor_id=state.motor_id,
                )
            if state.hardware_error:
                raise DeviceError(
                    "ID {motor_id}: hardware error {hardware_error}",
                    motor_id=state.motor_id,
                    hardware_error=state.hardware_error,
                )
            if state.status_return != 2:
                raise DeviceError("ID {motor_id}: Status Return Level (68) must be 2.", motor_id=state.motor_id)

    @staticmethod
    def _same_config(before: MotorState, now: MotorState) -> bool:
        return all(getattr(before, name) == getattr(now, name) for name in (
            "motor_id", "model", "firmware", "drive_mode", "operating_mode", "homing_offset",
            "min_position", "max_position", "baud_code",
        ))

    def save_zero(self, ids) -> Path:
        first = self.read_states(ids)
        self._editable(first)
        for state in first:
            validate_zero_mode(state)
        time.sleep(0.05)
        second = self.read_states(state.motor_id for state in first)
        self._editable(second)
        changes = []
        for before, state in zip(first, second):
            if not self._same_config(before, state) or abs(state.position - before.position) > TOLERANCE:
                raise DeviceError("ID {motor_id}: pose or settings changed. Hold the pose and read again.", motor_id=state.motor_id)
            validate_zero_mode(state)
            if state.operating_mode == 3 and not state.min_position <= DEFAULT_ZERO_PULSE <= state.max_position:
                raise DeviceError("ID {motor_id}: the reference position is outside the position limits.", motor_id=state.motor_id)
            offset = zero_offset(state)
            validate_offset(state.operating_mode, offset)
            changes.append((state.motor_id, 20, 4, offset))

        states = self.read_states(state.motor_id for state in second)
        self._editable(states)
        for old, now in zip(second, states):
            if not self._same_config(old, now) or abs(now.position - old.position) > TOLERANCE:
                raise DeviceError(
                    "ID {motor_id}: pose or settings changed before saving. Hold the reference pose and try again.",
                    motor_id=now.motor_id,
                )
        path, _ = self._commit("zero", states, changes, target=DEFAULT_ZERO_PULSE)
        return path

    def set_direction(self, ids, reverse: bool) -> Path:
        if type(reverse) is not bool:
            raise DeviceError("Choose forward or reverse.")
        states = self.read_states(ids)
        self._editable(states)
        changes = [(s.motor_id, 10, 1, (s.drive_mode & ~1) | int(reverse)) for s in states]
        path, _ = self._commit("direction", states, changes)
        return path

    def set_mode5(self, ids) -> tuple[Path | None, tuple[MotorState, ...]]:
        states = self.read_states(ids)
        pending = [state for state in states if state.operating_mode != CURRENT_BASED_POSITION_MODE]
        if not pending:
            return None, states
        self._editable(pending)
        changes = [(s.motor_id, OPERATING_MODE_ADDRESS, 1, CURRENT_BASED_POSITION_MODE) for s in pending]
        return self._commit("mode", states, changes)

    def set_id(self, motor_id: int, new_id: int) -> IdChangeResult:
        """Change one primary ID, with a journal and verification at the new ID."""
        for value in (motor_id, new_id):
            if type(value) is not int or not 0 <= value <= 252:
                raise DeviceError("Choose a motor ID from 0 to 252.")
        if motor_id == new_id:
            raise DeviceError("The new ID matches the current ID.")
        before = self.read_state(motor_id)
        self._editable((before,))
        if self.transport.read(motor_id, 7, 1) != motor_id:
            raise DeviceError("The selected ID does not match register 7. Check the connected motor.")
        if self.transport.ping(new_id) is not None:
            raise DeviceError("ID {new_id} is already in use. Choose another ID.", new_id=new_id)

        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S")
        prefix = 'demo' if self.transport.simulated else 'motor'
        path = self.backup_dir / f"{prefix}-{stamp}-{uuid4().hex[:8]}.json"
        journal = self._document((before,), "write_backup")
        change = {"motor_id": motor_id, "address": 7, "size": 1,
                  "value": new_id, "status": "pending"}
        journal.update(operation="id", status="prepared", old_id=motor_id,
                       new_id=new_id, changes=[change])
        atomic_json(path, journal)
        write_unverified = False
        try:
            now = self.read_state(motor_id)
            self._editable((now,))
            if (not self._same_config(before, now)
                    or self.transport.read(motor_id, 7, 1) != motor_id):
                raise DeviceError("Motor settings changed before the ID write. Read them again.")
            if self.transport.ping(new_id) is not None:
                raise DeviceError("ID {new_id} came into use before the write.", new_id=new_id)
            change.update(before=asdict(now), status="writing")
            atomic_json(path, journal)
            write_unverified = True
            self.transport.write(motor_id, 7, 1, new_id)
            time.sleep(0.05)
            after = self.read_state(new_id)
            change.update(after=asdict(after), readback=self.transport.read(new_id, 7, 1))
            atomic_json(path, journal)
            self._editable((after,))
            if change["readback"] != new_id:
                raise DeviceError("ID {new_id}: register 7 does not match the new ID.", new_id=new_id)
            if not self._same_config(replace(now, motor_id=new_id), after):
                raise DeviceError("Model, firmware, zero, direction, or mode changed after the ID write.")
            old_response = self.transport.ping(motor_id)
            change["old_id_response"] = old_response
            if old_response is not None:
                raise DeviceError("The old ID {motor_id} still responds. Check for duplicate IDs.", motor_id=motor_id)
            write_unverified = False
            change["status"] = "verified"
            journal["status"] = "verified"
            atomic_json(path, journal)
        except Exception as exc:
            if write_unverified:
                self.faulted = True
                recovery = translate(
                    "The ID change from {motor_id} to {new_id} may have been applied. Reconnect and scan before writing again.",
                    motor_id=motor_id,
                    new_id=new_id,
                )
            else:
                recovery = translate("Read the motor settings again before retrying.")
            journal.update(status="failed", error=str(exc))
            try:
                atomic_json(path, journal)
            except OSError:
                pass
            raise DeviceError("ID change stopped: {error}\n{recovery}\nBackup: {path}", error=exc, recovery=recovery, path=path) from exc
        return IdChangeResult(motor_id, after, path)

    def set_1mbps(self, motor_id: int) -> tuple[Path | None, MotorState]:
        started = step_started = time.monotonic()
        timings = {}

        def record_step(name):
            nonlocal step_started
            now = time.monotonic()
            timings[name] = round((now - step_started) * 1000)
            step_started = now

        transport = self.transport
        old_baud = transport.baud
        before = self.read_state(motor_id)
        if before.baud_rate != old_baud:
            raise DeviceError("The port speed does not match the motor's Baud Rate register (8).")
        if transport.read(motor_id, 7, 1) != motor_id:
            raise DeviceError("The selected ID does not match register 7.")
        if old_baud == TARGET_BAUD:
            return None, before
        self._editable((before,))

        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S")
        prefix = 'demo' if transport.simulated else 'motor'
        path = self.backup_dir / f"{prefix}-{stamp}-{uuid4().hex[:8]}.json"
        change = {"motor_id": motor_id, "address": BAUD_RATE_ADDRESS, "size": 1,
                  "value": TARGET_BAUD_CODE, "status": "pending"}
        journal = self._document((before,), "write_backup")
        journal.update(operation="baud", status="prepared", old_baud=old_baud,
                       old_baud_code=before.baud_code, new_baud=TARGET_BAUD,
                       changes=[change], timings_ms=timings)
        atomic_json(path, journal)
        record_step("initial_checks_and_backup")
        write_unverified = False
        adapter_speed_restored = False
        try:
            try:
                transport.set_baud(TARGET_BAUD)
                occupied = transport.ping(motor_id)
            finally:
                transport.set_baud(old_baud)
                adapter_speed_restored = True
            record_step("target_speed_probe")
            if occupied is not None:
                raise DeviceError("ID {motor_id} already responds at {baud} bps.", baud=TARGET_BAUD, motor_id=motor_id)
            if not transport.simulated and transport.scan() != {motor_id: before.model}:
                raise DeviceError("Connect only one motor to the U2D2 to change its baud rate.")
            record_step("source_bus_scan")

            now = self.read_state(motor_id)
            self._editable((now,))
            if not self._same_config(before, now) or transport.read(motor_id, 7, 1) != motor_id:
                raise DeviceError("Motor settings changed before the baud write. Read them again.")
            change.update(before=asdict(now), status="writing")
            atomic_json(path, journal)
            record_step("prewrite_checks_and_backup")
            write_unverified = True
            transport.write(motor_id, BAUD_RATE_ADDRESS, 1, TARGET_BAUD_CODE)
            time.sleep(0.05)
            record_step("write_and_settle")
            transport.set_baud(TARGET_BAUD)
            record_step("reopen_at_1mbps")
            after = self.read_state(motor_id)
            change.update(after=asdict(after), readback=after.baud_code)
            self._editable((after,))
            if (transport.read(motor_id, 7, 1) != motor_id
                    or not self._same_config(replace(now, baud_code=TARGET_BAUD_CODE), after)):
                raise DeviceError("ID {motor_id}: could not verify settings at the new baud rate.", motor_id=motor_id)
            write_unverified = False
            change["status"] = journal["status"] = "verified"
            record_step("readback")
            journal["elapsed_ms"] = round((step_started - started) * 1000)
            atomic_json(path, journal)
        except Exception as exc:
            if write_unverified or not adapter_speed_restored:
                self.faulted = True
            journal.update(status="failed", error=str(exc),
                           elapsed_ms=round((time.monotonic() - started) * 1000))
            try:
                atomic_json(path, journal)
            except OSError:
                pass
            if write_unverified:
                recovery = translate(
                    "Reconnect and check both {baud} bps and the previous speed of {old_baud} bps.",
                    baud=TARGET_BAUD,
                    old_baud=old_baud,
                )
            elif not adapter_speed_restored:
                recovery = translate("Could not restore the adapter speed. Reconnect at {old_baud} bps.", old_baud=old_baud)
            else:
                recovery = translate("Read the motor settings again before retrying.")
            raise DeviceError("Baud change stopped: {error}\n{recovery}\nBackup: {path}", error=exc, recovery=recovery, path=path) from exc
        return path, after

    def torque_off(self, ids) -> None:
        # Torque OFF remains available when unrelated telemetry reads fail.
        errors = []
        for motor_id in dict.fromkeys(ids):
            try:
                self._read_supported_model(motor_id)
                self.transport.write(motor_id, 64, 1, 0)
                if self.transport.read(motor_id, 64, 1) != 0:
                    raise DeviceError("Could not verify torque off")
            except Exception as exc:
                errors.append(f"ID {motor_id}: {exc}")
        if errors:
            raise DeviceError("\n".join(errors))

    def _document(self, states, kind: str) -> dict:
        return {
            "schema_version": 1, "kind": kind,
            "created_utc": datetime.now(timezone.utc).isoformat(),
            "simulated": self.transport.simulated,
            "motors": [asdict(s) for s in states],
        }

    def export(self, ids, path: Path) -> Path:
        states = self.read_states(ids)
        atomic_json(path, self._document(states, "settings_snapshot"))
        return path

    def restore(self, ids, path: Path) -> Path:
        with Path(path).open(encoding="utf-8") as stream:
            data = json.load(stream)
        if (not isinstance(data, dict) or data.get("schema_version") != 1
                or type(data.get("simulated")) is not bool
                or data["simulated"] != self.transport.simulated):
            raise DeviceError("The backup format or hardware/simulation mode does not match.")
        if data.get("kind") not in ("write_backup", "settings_snapshot"):
            raise DeviceError("Unsupported backup type.")
        motors = data.get("motors")
        if not isinstance(motors, list) or not motors:
            raise DeviceError("The backup contains no motors.")
        by_id = {}
        for motor in motors:
            if not isinstance(motor, dict):
                raise DeviceError("Invalid motor entry in the backup.")
            for key in ("motor_id", "model", "drive_mode", "operating_mode", "homing_offset"):
                if type(motor.get(key)) is not int:
                    raise DeviceError("Invalid backup field: {key}", key=key)
            i = motor["motor_id"]
            if not 0 <= i <= 252 or i in by_id or not 0 <= motor["drive_mode"] <= 13:
                raise DeviceError("The backup contains an invalid motor ID or direction, or a duplicate ID.")
            by_id[i] = motor
        states = self.read_states(ids)
        self._editable(states)
        changes = []
        for state in states:
            old = by_id.get(state.motor_id)
            if old is None or old["model"] != state.model or old["operating_mode"] != state.operating_mode:
                raise DeviceError("ID {motor_id}: the backup ID, model, or operating mode does not match.", motor_id=state.motor_id)
            validate_offset(state.operating_mode, old["homing_offset"])
            # Restore only direction bit; preserve unrelated profile/auto-torque bits.
            drive = (state.drive_mode & ~1) | (old["drive_mode"] & 1)
            changes.extend(((state.motor_id, 10, 1, drive), (state.motor_id, 20, 4, old["homing_offset"])))
        path, _ = self._commit("restore", states, changes)
        return path

    def _commit(self, kind, states, changes, target=None) -> tuple[Path, tuple[MotorState, ...]]:
        """All motors preflighted before first write; never auto-roll back on failure."""
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S")
        name = f"{'demo' if self.transport.simulated else 'motor'}-{stamp}-{uuid4().hex[:8]}.json"
        path = self.backup_dir / name
        journal = self._document(states, "write_backup")
        journal.update(operation=kind, status="prepared", target=target, changes=[
            {"motor_id": i, "address": a, "size": size, "value": value, "status": "pending"}
            for i, a, size, value in changes
        ])
        atomic_json(path, journal)  # Must succeed before touching EEPROM.
        expected = {s.motor_id: s for s in states}
        write_unverified = False
        try:
            for change in journal["changes"]:
                i, address, size, value = (change[k] for k in ("motor_id", "address", "size", "value"))
                now = self.read_state(i)
                self._editable((now,))
                if not self._same_config(expected[i], now):
                    raise DeviceError("ID {motor_id}: settings changed while saving.", motor_id=i)
                if target is not None and abs(now.position - expected[i].position) > TOLERANCE:
                    raise DeviceError("ID {motor_id}: pose changed while saving.", motor_id=i)
                change["before"] = asdict(now)
                field = SETTING_FIELDS[address]
                current = getattr(now, field)
                if current == value:
                    change["status"] = "unchanged"
                else:
                    change["status"] = "writing"
                    atomic_json(path, journal)
                    write_unverified = True
                    self.transport.write(i, address, size, value)
                    readback = self.transport.read(i, address, size)
                    if size == 4:
                        readback = signed(readback, 32)
                    change["readback"] = readback
                    if readback != value:
                        raise DeviceError(
                            "ID {motor_id}: register {address} read back {actual}; expected {value}.",
                            motor_id=i,
                            address=address,
                            actual=readback,
                            value=value,
                        )
                after = self.read_state(i)
                change["after"] = asdict(after)
                self._editable((after,))
                confirmed_value = getattr(after, field)
                if confirmed_value != value:
                    raise DeviceError(
                        "ID {motor_id}: register {address} read back {actual}; expected {value}.",
                        motor_id=i,
                        address=address,
                        actual=confirmed_value,
                        value=value,
                    )
                if target is not None and abs(after.position - target) > TOLERANCE:
                    raise DeviceError(
                        "ID {motor_id}: position after saving zero was {position}, expected {target} (difference {difference} pulses, mode {mode}, {direction}, homing offset {offset}). Check the position before writing again.",
                        motor_id=i,
                        position=after.position,
                        target=target,
                        difference=after.position - target,
                        mode=after.operating_mode,
                        direction=translate("Reverse") if after.reverse else translate("Forward"),
                        offset=after.homing_offset,
                    )
                if write_unverified:
                    write_unverified = False
                    change["status"] = "verified"
                expected[i] = after
                atomic_json(path, journal)
            journal["status"] = "verified"
            atomic_json(path, journal)
        except Exception as exc:
            if write_unverified:
                self.faulted = True
                recovery = translate("Some values may have been saved. Reconnect and check the motor settings.")
            else:
                recovery = translate("Read the motor settings again before retrying.")
            journal.update(status="failed", error=str(exc))
            try:
                atomic_json(path, journal)
            except OSError:
                pass  # Pre-write journal still records the possibly attempted write.
            completed = [f'ID {c["motor_id"]} @{c["address"]}' for c in journal["changes"]
                         if c["status"] in ("verified", "unchanged")]
            raise DeviceError(
                "Write stopped: {error}\nCompleted: {completed}\n{recovery}\nBackup: {path}",
                error=exc,
                completed=", ".join(completed) or translate("None"),
                recovery=recovery,
                path=path,
            ) from exc
        return path, tuple(expected.values())
