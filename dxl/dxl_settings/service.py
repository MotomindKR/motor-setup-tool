"""Motor configuration, with checked writes and pre-write backup journals."""
from __future__ import annotations

from dataclasses import asdict, dataclass, replace
from datetime import datetime, timezone
import json
from math import tau
from pathlib import Path
import time
from uuid import uuid4

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
        return MODELS.get(self.model, f"미지원 모델 ({self.model})")

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
class ZeroPlan:
    states: tuple[MotorState, ...]
    target: int
    offsets: tuple[int, ...]


@dataclass(frozen=True)
class IdChangeResult:
    old_id: int
    state: MotorState
    backup_path: Path


def validate_offset(mode: int, value: int) -> None:
    if mode not in POSITION_MODES:
        raise DeviceError(f"위치 제어 모드 3/4/5에서 보정하세요. 현재 모드: {mode}")
    limit = 1024 if mode == 3 else 1_044_479
    if type(value) is not int or not -limit <= value <= limit:
        raise DeviceError(f"모드 {mode}의 Homing Offset 범위 초과: {value} (±{limit})")


def validate_zero_target(target: int) -> None:
    if type(target) is not int or target != DEFAULT_ZERO_PULSE:
        raise DeviceError("영점 기준은 2048 pulse (π rad)로 고정되어 있습니다. "
                          "0 pulse 및 다른 기준값으로 저장할 수 없습니다.")


def validate_zero_mode(state: MotorState) -> None:
    # Preserve the existing 2048 calibration support without changing motor mode.
    validate_offset(state.operating_mode, 0)


def zero_offset(state: MotorState, target: int) -> int:
    # XL330 mode-5 Reverse response observed on firmware 53:
    # ID 40: position 2056, offset -3 -> offset -2059 yielded position 4112.
    # In Reverse, increasing the stored offset decreases reported position.
    # Keep readback verification mandatory; do not wrap an error into success.
    correction = target - state.position
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

    def read_state(self, motor_id: int) -> MotorState:
        if type(motor_id) is not int or not 0 <= motor_id <= 252:
            raise DeviceError("모터 ID는 0~252여야 합니다.")
        r = lambda address, size=1: self.transport.read(motor_id, address, size)
        model = r(0, 2)
        if model not in MODELS:
            # Do not interpret unknown models with the XL330 register map.
            raise DeviceError(f"ID {motor_id}: 지원하지 않는 모델 {model}")
        return MotorState(
            motor_id, model, r(6), r(10), r(OPERATING_MODE_ADDRESS), signed(r(20, 4), 32),
            r(52, 4), r(48, 4), r(64), r(68), r(70),
            signed(r(132, 4), 32), signed(r(126, 2), 16), r(144, 2) / 10, r(146),
            baud_code=r(BAUD_RATE_ADDRESS),
        )

    def read_states(self, ids) -> tuple[MotorState, ...]:
        ids = tuple(ids)
        if not ids or len(ids) != len(set(ids)):
            raise DeviceError("서로 다른 모터 ID를 하나 이상 선택하세요.")
        return tuple(self.read_state(i) for i in ids)

    def scan(self) -> tuple[MotorState, ...]:
        devices = self.transport.scan()
        ids = sorted(i for i, model in devices.items() if model in MODELS)
        if not ids:
            raise NoSupportedMotors("XL330-M288-T / M077-T를 찾지 못했습니다. 포트·baud·전원을 확인하세요.")
        return self.read_states(ids)

    def _editable(self, states) -> None:
        if self.faulted:
            raise DeviceError("저장 실패 후 쓰기가 잠겼습니다. 연결을 끊고 실제 값을 다시 읽으세요.")
        for state in states:
            if state.torque != 0:
                raise DeviceError(f"ID {state.motor_id}: 팔을 지지하고 [선택 토크 OFF] 후 저장하세요.")
            if state.hardware_error:
                raise DeviceError(f"ID {state.motor_id}: Hardware Error = {state.hardware_error}")
            if state.status_return != 2:
                raise DeviceError(f"ID {state.motor_id}: Status Return Level(68)=2가 필요합니다.")

    @staticmethod
    def _same_config(before: MotorState, now: MotorState) -> bool:
        return all(getattr(before, name) == getattr(now, name) for name in (
            "motor_id", "model", "firmware", "drive_mode", "operating_mode", "homing_offset",
            "min_position", "max_position", "baud_code",
        ))

    def preview_zero(self, ids, target: int = DEFAULT_ZERO_PULSE) -> ZeroPlan:
        validate_zero_target(target)
        first = self.read_states(ids)
        self._editable(first)
        for state in first:
            validate_zero_mode(state)
        time.sleep(0.05)
        second = self.read_states([s.motor_id for s in first])
        self._editable(second)
        offsets = []
        for before, state in zip(first, second):
            if not self._same_config(before, state) or abs(state.position - before.position) > TOLERANCE:
                raise DeviceError(f"ID {state.motor_id}: 자세/설정이 변했습니다. 고정 후 다시 읽으세요.")
            validate_zero_mode(state)
            if state.operating_mode == 3 and not state.min_position <= target <= state.max_position:
                raise DeviceError(f"ID {state.motor_id}: 기준 pulse가 모터 위치 한계를 벗어납니다.")
            offset = zero_offset(state, target)
            validate_offset(state.operating_mode, offset)
            offsets.append(offset)
        return ZeroPlan(second, target, tuple(offsets))

    def apply_zero(self, plan: ZeroPlan) -> Path:
        if not isinstance(plan, ZeroPlan) or not plan.states or len(plan.states) != len(plan.offsets):
            raise DeviceError("영점 저장에 필요한 위치값을 확인하지 못했습니다.")
        validate_zero_target(plan.target)
        states = self.read_states([s.motor_id for s in plan.states])
        self._editable(states)
        changes = []
        for old, now, offset in zip(plan.states, states, plan.offsets):
            if not self._same_config(old, now) or abs(now.position - old.position) > TOLERANCE:
                raise DeviceError(f"ID {now.motor_id}: 저장 전에 자세/설정이 바뀌었습니다. 기준 자세를 고정하고 다시 저장하세요.")
            validate_zero_mode(now)
            validate_offset(now.operating_mode, offset)
            if offset != zero_offset(old, plan.target):
                raise DeviceError("영점 계산값이 일치하지 않습니다.")
            changes.append((now.motor_id, 20, 4, offset))
        path, _ = self._commit("zero", states, changes, target=plan.target)
        return path

    def set_direction(self, ids, reverse: bool) -> Path:
        if type(reverse) is not bool:
            raise DeviceError("방향은 정방향 또는 역방향이어야 합니다.")
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
                raise DeviceError("모터 ID는 0~252 정수여야 합니다.")
        if motor_id == new_id:
            raise DeviceError("현재 ID와 새 ID가 같습니다.")
        before = self.read_state(motor_id)
        self._editable((before,))
        if self.transport.read(motor_id, 7, 1) != motor_id:
            raise DeviceError("선택 ID와 모터의 ID(7)가 다릅니다. 실제 연결을 확인하세요.")
        if self.transport.ping(new_id) is not None:
            raise DeviceError(f"ID {new_id}는 이미 사용 중입니다. 다른 ID를 입력하세요.")

        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S")
        prefix = 'demo' if self.transport.simulated else 'motor'
        path = self.backup_dir / f"{prefix}-{stamp}-{uuid4().hex[:8]}.json"
        journal = self._document((before,), "write_backup")
        change = {"motor_id": motor_id, "address": 7, "size": 1,
                  "value": new_id, "status": "pending"}
        journal.update(operation="id", status="prepared", old_id=motor_id,
                       new_id=new_id, changes=[change])
        atomic_json(path, journal)
        try:
            now = self.read_state(motor_id)
            self._editable((now,))
            if (not self._same_config(before, now)
                    or self.transport.read(motor_id, 7, 1) != motor_id):
                raise DeviceError("ID 저장 직전 모터 설정이 바뀌었습니다. 다시 읽으세요.")
            if self.transport.ping(new_id) is not None:
                raise DeviceError(f"ID {new_id}가 저장 직전에 사용 중으로 확인되었습니다.")
            change.update(before=asdict(now), status="writing")
            atomic_json(path, journal)
            self.transport.write(motor_id, 7, 1, new_id)
            time.sleep(0.05)
            after = self.read_state(new_id)
            change.update(after=asdict(after), readback=self.transport.read(new_id, 7, 1))
            atomic_json(path, journal)
            self._editable((after,))
            if change["readback"] != new_id:
                raise DeviceError(f"새 ID {new_id}의 ID(7) 저장값 불일치")
            if not self._same_config(replace(now, motor_id=new_id), after):
                raise DeviceError("ID 변경 후 모델·펌웨어·영점·방향·모드 설정 불일치")
            old_response = self.transport.ping(motor_id)
            change["old_id_response"] = old_response
            if old_response is not None:
                raise DeviceError(f"이전 ID {motor_id}가 여전히 응답합니다. 중복 ID/연결을 확인하세요.")
            change["status"] = "verified"
            journal["status"] = "verified"
            atomic_json(path, journal)
        except Exception as exc:
            self.faulted = True
            journal.update(status="failed", error=str(exc))
            try:
                atomic_json(path, journal)
            except OSError:
                pass
            raise DeviceError(f"ID 저장 중단: {exc}\nID {motor_id} → {new_id}가 이미 적용되었을 수 있습니다. "
                              f"추가 저장 없이 재연결 후 모터 검색으로 확인하세요.\n백업: {path}") from exc
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
            raise DeviceError("연결 속도와 모터의 Baud Rate(8) 값이 일치하지 않습니다.")
        if transport.read(motor_id, 7, 1) != motor_id:
            raise DeviceError("선택 ID와 모터의 ID(7)가 다릅니다.")
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
        attempted = False
        try:
            try:
                transport.set_baud(TARGET_BAUD)
                occupied = transport.ping(motor_id)
            finally:
                transport.set_baud(old_baud)
            record_step("target_speed_probe")
            if occupied is not None:
                raise DeviceError(f"{TARGET_BAUD} bps에서 ID {motor_id}가 이미 응답합니다.")
            if not transport.simulated and transport.scan() != {motor_id: before.model}:
                raise DeviceError("속도를 변경할 모터 한 대만 U2D2에 연결하세요.")
            record_step("source_bus_scan")

            now = self.read_state(motor_id)
            self._editable((now,))
            if not self._same_config(before, now) or transport.read(motor_id, 7, 1) != motor_id:
                raise DeviceError("속도 저장 직전 모터 설정이 바뀌었습니다. 다시 읽으세요.")
            change.update(before=asdict(now), status="writing")
            atomic_json(path, journal)
            record_step("prewrite_checks_and_backup")
            attempted = True
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
                raise DeviceError(f"ID {motor_id}: 새 속도에서 모터 설정 재확인 실패")
            change["status"] = journal["status"] = "verified"
            record_step("readback")
            journal["elapsed_ms"] = round((step_started - started) * 1000)
            atomic_json(path, journal)
        except Exception as exc:
            self.faulted = True
            journal.update(status="failed", error=str(exc),
                           elapsed_ms=round((time.monotonic() - started) * 1000))
            try:
                atomic_json(path, journal)
            except OSError:
                pass
            recovery = (f"재연결 후 {TARGET_BAUD} bps와 이전 {old_baud} bps에서 확인하세요."
                        if attempted else f"쓰기 전에 중단되었습니다. {old_baud} bps로 재연결하세요.")
            raise DeviceError(f"속도 저장 중단: {exc}\n{recovery}\n백업: {path}") from exc
        return path, after

    def torque_off(self, ids) -> None:
        # Do not require a clean hardware status just to attempt torque OFF.
        errors = []
        for motor_id in dict.fromkeys(ids):
            try:
                state = self.read_state(motor_id)
                if state.torque:
                    self.transport.write(motor_id, 64, 1, 0)
                if self.transport.read(motor_id, 64, 1) != 0:
                    raise DeviceError("토크 OFF 확인 실패")
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
            raise DeviceError("백업 형식 또는 실물/가상 모드가 일치하지 않습니다.")
        if data.get("kind") not in ("write_backup", "settings_snapshot"):
            raise DeviceError("지원하지 않는 백업 종류입니다.")
        motors = data.get("motors")
        if not isinstance(motors, list) or not motors:
            raise DeviceError("백업에 모터 정보가 없습니다.")
        by_id = {}
        for motor in motors:
            if not isinstance(motor, dict):
                raise DeviceError("잘못된 모터 백업 항목")
            for key in ("motor_id", "model", "drive_mode", "operating_mode", "homing_offset"):
                if type(motor.get(key)) is not int:
                    raise DeviceError(f"잘못된 백업 필드: {key}")
            i = motor["motor_id"]
            if not 0 <= i <= 252 or i in by_id or not 0 <= motor["drive_mode"] <= 13:
                raise DeviceError("백업의 모터 ID/방향 값이 잘못됐거나 중복되었습니다.")
            by_id[i] = motor
        states = self.read_states(ids)
        self._editable(states)
        changes = []
        for state in states:
            old = by_id.get(state.motor_id)
            if old is None or old["model"] != state.model or old["operating_mode"] != state.operating_mode:
                raise DeviceError(f"ID {state.motor_id}: 백업의 ID·모델·동작 모드가 일치하지 않습니다.")
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
        try:
            for change in journal["changes"]:
                i, address, size, value = (change[k] for k in ("motor_id", "address", "size", "value"))
                now = self.read_state(i)
                self._editable((now,))
                if not self._same_config(expected[i], now):
                    raise DeviceError(f"ID {i}: 저장 도중 설정이 바뀌었습니다.")
                if target is not None and abs(now.position - expected[i].position) > TOLERANCE:
                    raise DeviceError(f"ID {i}: 저장 도중 자세가 바뀌었습니다.")
                change["before"] = asdict(now)
                field = SETTING_FIELDS[address]
                current = getattr(now, field)
                if current == value:
                    change["status"] = "unchanged"
                else:
                    change["status"] = "writing"
                    atomic_json(path, journal)
                    self.transport.write(i, address, size, value)
                    readback = self.transport.read(i, address, size)
                    if size == 4:
                        readback = signed(readback, 32)
                    change["readback"] = readback
                    if readback != value:
                        raise DeviceError(f"ID {i}: 저장값 불일치 @{address}: {readback} != {value}")
                after = self.read_state(i)
                change["after"] = asdict(after)
                self._editable((after,))
                confirmed_value = getattr(after, field)
                if confirmed_value != value:
                    raise DeviceError(f"ID {i}: 저장값 불일치 @{address}: {confirmed_value} != {value}")
                if current != value:
                    change["status"] = "verified"
                if target is not None and abs(after.position - target) > TOLERANCE:
                    raise DeviceError(f"ID {i}: 영점 저장 후 위치 {after.position}, 기준 {target} 불일치 "
                                      f"(차이 {after.position - target} pulse, "
                                      f"모드 {after.operating_mode}, "
                                      f"{'역방향' if after.reverse else '정방향'}, "
                                      f"Homing Offset {after.homing_offset}). "
                                      "추가 저장 없이 실제 값을 확인하세요.")
                expected[i] = after
                atomic_json(path, journal)
            journal["status"] = "verified"
            atomic_json(path, journal)
        except Exception as exc:
            self.faulted = True
            journal.update(status="failed", error=str(exc))
            try:
                atomic_json(path, journal)
            except OSError:
                pass  # Pre-write journal still records the possibly attempted write.
            completed = [f'ID {c["motor_id"]} @{c["address"]}' for c in journal["changes"]
                         if c["status"] in ("verified", "unchanged")]
            raise DeviceError(f"저장 중단: {exc}\n완료: {', '.join(completed) or '없음'}\n"
                              f"일부 값은 저장되었을 수 있습니다. 재연결 후 확인하세요.\n백업: {path}") from exc
        return path, tuple(expected.values())
