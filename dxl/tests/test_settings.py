import json
from dataclasses import replace
from math import pi

import pytest

from dxl_settings.service import SettingsService, zero_offset
from dxl_settings.transport import DemoTransport, DeviceError, check_write


@pytest.fixture
def setup(tmp_path):
    transport = DemoTransport()
    return transport, SettingsService(transport, tmp_path / "backups")


def test_connect_and_preview_do_not_write(setup):
    bus, service = setup
    states = service.scan()
    assert len(states) == 7
    assert [s.model for s in states] == [1200] * 6 + [1190]
    service.preview_zero(range(30, 37))
    assert bus.writes == []


@pytest.mark.parametrize("reverse,old_offset", [(False, 0), (True, 137), (False, -200)])
def test_zero_includes_old_offset_and_preserves_direction(setup, reverse, old_offset):
    bus, service = setup
    bus.registers[30][10] = int(reverse) | 12  # keep time-profile and auto-torque bits
    bus.registers[30][20] = old_offset & 0xFFFFFFFF
    plan = service.preview_zero([30])
    path = service.apply_zero(plan)
    state = service.read_state(30)
    assert state.position == 2048
    assert state.radians == pytest.approx(pi) and state.degrees == 180
    assert state.joint_radians == state.joint_degrees == 0
    assert state.operating_mode == 5 and state.torque == 0
    assert state.drive_mode == int(reverse) | 12
    assert [w[1] for w in bus.writes] == [20]
    saved = json.loads(path.read_text())
    assert saved["motors"][0]["homing_offset"] == old_offset
    assert saved["status"] == "verified"
    # Repeating calibration doesn't accumulate the offset or wear EEPROM.
    service.apply_zero(service.preview_zero([30]))
    assert len(bus.writes) == 1


def test_direction_preserves_other_bits_and_offset(setup):
    bus, service = setup
    bus.registers[30][10] = 12
    bus.registers[30][20] = 123
    service.set_direction([30], True)
    assert bus.registers[30][10] == 13
    assert bus.registers[30][20] == 123
    service.set_direction([30], False)
    assert bus.registers[30][10] == 12


@pytest.mark.parametrize("field,value", [(64, 1), (70, 4), (68, 1)])
def test_preflight_all_motors_before_any_write(setup, field, value):
    bus, service = setup
    bus.registers[36][field] = value
    with pytest.raises(DeviceError):
        service.set_direction(range(30, 37), True)
    assert bus.writes == []


def test_mode_three_offset_bound_and_target_limits(setup):
    bus, service = setup
    bus.registers[30][11] = 3
    bus.physical[30] = 300
    with pytest.raises(DeviceError, match="범위 초과"):
        service.preview_zero([30], target=2048)
    bus.physical[30] = 1024
    service.apply_zero(service.preview_zero([30], target=2048))
    assert service.read_state(30).homing_offset == 1024
    bus.registers[30][48] = 1000
    with pytest.raises(DeviceError, match="위치 한계"):
        service.preview_zero([30], target=2048)


@pytest.mark.parametrize("mode", [3, 4])
def test_fixed_pi_reference_preserves_existing_position_modes(setup, mode):
    bus, service = setup
    bus.registers[36][11] = mode
    service.apply_zero(service.preview_zero(range(30, 37)))
    assert all(s.position == 2048 for s in service.read_states(range(30, 37)))
    assert bus.registers[36][11] == mode


def test_default_zero_all_axes_and_signed_motion(setup):
    bus, service = setup
    before = service.read_states(range(30, 37))
    service.apply_zero(service.preview_zero(range(30, 37)))
    after = service.read_states(range(30, 37))
    assert all(s.position == 2048 and s.joint_radians == 0 and s.joint_degrees == 0 for s in after)
    assert [s.operating_mode for s in after] == [s.operating_mode for s in before]
    assert all(s.torque == 0 for s in after)
    assert all(address == 20 for _, address, _, _ in bus.writes)
    for delta in (-1024, 1024):
        start = bus.physical[30]
        bus.physical[30] = start + delta
        state = service.read_state(30)
        assert state.position == 2048 + delta
        assert state.radians == pytest.approx(pi + delta / 1024 * pi / 2)
        assert state.degrees == 180 + delta / 1024 * 90
        assert state.joint_radians == pytest.approx(delta / 1024 * pi / 2)
        assert state.joint_degrees == delta / 1024 * 90
        bus.physical[30] = start


def test_explicit_fixed_reference_keeps_pi(setup):
    bus, service = setup
    service.apply_zero(service.preview_zero([30], target=2048))
    state = service.read_state(30)
    assert state.position == 2048
    assert state.radians == pytest.approx(pi)
    assert state.degrees == 180
    assert bus.registers[30][11] == 5 and bus.registers[30][64] == 0


@pytest.mark.parametrize("target", [0, -500, 4096, 2047, 2048.0, True, None, "2048", 2**31])
def test_non_pi_reference_rejected_before_device_access(setup, monkeypatch, target):
    bus, service = setup
    def unexpected_read(*_):
        raise AssertionError("Invalid calibration target must not access a motor")
    monkeypatch.setattr(bus, "read", unexpected_read)
    with pytest.raises(DeviceError, match="2048 pulse.*고정"):
        service.preview_zero([30], target=target)
    assert bus.writes == []
    assert not service.backup_dir.exists()


@pytest.mark.parametrize("target", [0, -500, 4096, 2048.0])
def test_stale_or_modified_target_plan_cannot_write(setup, target):
    bus, service = setup
    plan = service.preview_zero([30])
    # Include a consistent offset: rejecting the target must not depend on an
    # unrelated mismatch in a stale plan made by the previous 0-reference app.
    offsets = tuple(zero_offset(s, target) for s in plan.states)
    with pytest.raises(DeviceError, match="고정"):
        service.apply_zero(replace(plan, target=target, offsets=offsets))
    assert bus.writes == []
    assert not service.backup_dir.exists()


def test_joint_display_does_not_hide_whole_turn_error(setup):
    bus, service = setup
    bus.physical[30] = 2048 + 4096
    state = service.read_state(30)
    assert state.radians == pytest.approx(3 * pi)
    assert state.joint_radians == pytest.approx(2 * pi)
    assert state.joint_degrees == 360


def test_mode_change_after_default_zero_preview_rejected(setup):
    bus, service = setup
    plan = service.preview_zero([30])
    bus.registers[30][11] = 3
    with pytest.raises(DeviceError, match="바뀌었습니다"):
        service.apply_zero(plan)
    assert bus.writes == []


@pytest.mark.parametrize("physical", [2048 - 1_044_480, 2048 + 1_044_480])
def test_mode_five_zero_offset_overflow_rejected(setup, physical):
    bus, service = setup
    bus.physical[30] = physical
    with pytest.raises(DeviceError, match="범위 초과"):
        service.preview_zero([30])
    assert bus.writes == []


@pytest.mark.parametrize("mode", [0, 1, 16])
def test_non_position_modes_cannot_calibrate(setup, mode):
    bus, service = setup
    bus.registers[30][11] = mode
    with pytest.raises(DeviceError, match="위치 제어"):
        service.preview_zero([30])
    assert bus.writes == []


def test_signed_positions_and_negative_offset(setup):
    bus, service = setup
    bus.physical[30] = -200
    bus.registers[30][126] = 0xFFEC
    assert service.read_state(30).position == -200
    assert service.read_state(30).current_ma == -20
    bus.physical[30] = 2250
    service.apply_zero(service.preview_zero([30]))
    assert service.read_state(30).position == 2048
    assert service.read_state(30).homing_offset == -202


def test_moved_pose_or_changed_direction_invalidates_preview(setup):
    bus, service = setup
    plan = service.preview_zero([30])
    bus.physical[30] += 40
    with pytest.raises(DeviceError, match="바뀌었습니다"):
        service.apply_zero(plan)
    bus.physical[30] -= 40
    bus.registers[30][10] = 1
    with pytest.raises(DeviceError, match="바뀌었습니다"):
        service.apply_zero(plan)
    assert bus.writes == []


def test_motion_during_capture_rejected(setup, monkeypatch):
    bus, service = setup
    monkeypatch.setattr("dxl_settings.service.time.sleep", lambda _: bus.physical.__setitem__(30, 2000))
    with pytest.raises(DeviceError, match="고정"):
        service.preview_zero([30])


def test_failed_backup_prevents_eeprom_writes(setup, monkeypatch):
    bus, service = setup
    monkeypatch.setattr("dxl_settings.service.atomic_json", lambda *_: (_ for _ in ()).throw(OSError("disk full")))
    with pytest.raises(OSError, match="disk full"):
        service.set_direction([30], True)
    assert bus.writes == []


def test_partial_write_timeout_is_journaled_and_not_rolled_back(setup, monkeypatch):
    bus, service = setup
    original = bus.write
    def write(motor_id, *args):
        original(motor_id, *args)
        if motor_id == 31:
            raise DeviceError("response timeout")  # Device accepted write, reply lost.
    monkeypatch.setattr(bus, "write", write)
    with pytest.raises(DeviceError, match="일부 값"):
        service.set_direction([30, 31, 32], True)
    assert bus.registers[30][10] == bus.registers[31][10] == 1
    assert bus.registers[32][10] == 0
    document = json.loads(next(service.backup_dir.glob("*.json")).read_text())
    assert document["status"] == "failed"
    assert [c["status"] for c in document["changes"]] == ["verified", "writing", "pending"]
    with pytest.raises(DeviceError, match="잠겼습니다"):
        service.set_direction([32], True)


def test_silent_write_failure_is_not_success(setup, monkeypatch):
    bus, service = setup
    monkeypatch.setattr(bus, "write", lambda *_: None)
    with pytest.raises(DeviceError, match="저장값 불일치"):
        service.set_direction([30], True)
    assert service.faulted


def test_position_verification_after_offset_write(setup, monkeypatch):
    bus, service = setup
    original = bus.write
    def write(*args):
        original(*args)
        bus.physical[30] += 100
    monkeypatch.setattr(bus, "write", write)
    with pytest.raises(DeviceError, match="영점 저장 후 위치"):
        service.apply_zero(service.preview_zero([30]))


@pytest.mark.parametrize("turn_delta", [-4096, 4096])
def test_whole_turn_mismatch_never_accepted_as_zero(setup, monkeypatch, turn_delta):
    bus, service = setup
    original = bus.write
    def write(*args):
        original(*args)
        bus.physical[30] += turn_delta
    monkeypatch.setattr(bus, "write", write)
    before = service.read_state(30)
    with pytest.raises(DeviceError, match="차이"):
        service.apply_zero(service.preview_zero([30]))
    assert service.faulted
    document = json.loads(next(service.backup_dir.glob("*.json")).read_text())
    change = document["changes"][0]
    assert document["status"] == "failed"
    assert change["before"]["position"] == before.position
    assert change["readback"] == change["after"]["homing_offset"] == 2048 - before.position
    assert change["after"]["position"] == 2048 + turn_delta
    assert len(bus.writes) == 1
    with pytest.raises(DeviceError, match="잠겼습니다"):
        service.apply_zero(service.preview_zero([30]))
    assert len(bus.writes) == 1


@pytest.mark.parametrize("old_offset,position", [(-2059, 4112), (2053, 0)])
def test_reported_xl330_firmware53_reverse_offsets_recovered_to_pi(setup, old_offset, position):
    bus, service = setup
    bus.registers[40] = bus.registers.pop(30)
    bus.physical[40] = 2042
    bus.physical.pop(30)
    bus.registers[40][6] = 53
    bus.registers[40][10] = 1
    bus.registers[40][20] = old_offset & 0xFFFFFFFF
    state = service.read_state(40)
    assert state.position == position and state.homing_offset == old_offset
    plan = service.preview_zero([40])
    assert plan.offsets == (5,)
    service.apply_zero(plan)
    state = service.read_state(40)
    assert state.position == 2048 and state.radians == pytest.approx(pi)
    assert state.joint_radians == 0
    assert state.homing_offset == 5
    assert state.reverse and state.operating_mode == 5 and state.torque == 0
    assert bus.physical[40] == 2042
    assert bus.writes == [(40, 20, 4, 5)]
    service.apply_zero(service.preview_zero([40]))
    assert len(bus.writes) == 1


def test_restore_direction_and_zero_only(setup, tmp_path):
    bus, service = setup
    path = service.export([30], tmp_path / "snapshot.json")
    service.set_direction([30], True)
    service.apply_zero(service.preview_zero([30]))
    bus.registers[30][10] |= 12
    service.restore([30], path)
    assert bus.registers[30][10] == 12
    assert bus.registers[30][20] == 0
    assert bus.registers[30][11] == 5
    assert all(address in (10, 20) for _, address, _, _ in bus.writes)


@pytest.mark.parametrize("mutation", ["duplicate", "different_model", "different_mode", "float_offset", "real_snapshot"])
def test_invalid_restore_never_partially_writes(setup, tmp_path, mutation):
    bus, service = setup
    path = service.export([30, 31], tmp_path / "snapshot.json")
    data = json.loads(path.read_text())
    if mutation == "duplicate":
        data["motors"].append(data["motors"][0])
    elif mutation == "different_model":
        data["motors"][1]["model"] = 1190
    elif mutation == "different_mode":
        data["motors"][1]["operating_mode"] = 3
    elif mutation == "float_offset":
        data["motors"][1]["homing_offset"] = 0.5
    else:
        data["simulated"] = False
    path.write_text(json.dumps(data))
    with pytest.raises(DeviceError):
        service.restore([30, 31], path)
    assert bus.writes == []


def test_torque_off_and_no_automatic_torque_on(setup):
    bus, service = setup
    bus.registers[30][64] = bus.registers[31][64] = 1
    service.torque_off([30, 31])
    service.close()
    assert bus.writes == [(30, 64, 1, 0), (31, 64, 1, 0)]


@pytest.mark.parametrize("address,size,value", [(64, 1, 1), (116, 4, 2048), (7, 2, 1),
                                               (11, 1, 3), (11, 1, 5.0), (11, 2, 5)])
def test_transport_blocks_motion_and_other_operating_mode_values(address, size, value):
    with pytest.raises(DeviceError):
        check_write(address, size, value)


@pytest.mark.parametrize("register,value", [(64, 1), (70, 4), (68, 1)])
def test_mode_five_requires_all_changed_motors_to_pass_preflight(setup, register, value):
    bus, service = setup
    bus.registers[30][11] = 3
    bus.registers[36][register] = value
    with pytest.raises(DeviceError):
        service.set_mode5([30, 36])
    assert bus.writes == []


def test_mode_five_requires_readback_and_locks_further_writes_on_failure(setup, monkeypatch):
    bus, service = setup
    monkeypatch.setattr(bus, "write", lambda *_: None)
    with pytest.raises(DeviceError, match="저장값 불일치 @11"):
        service.set_mode5([36])
    assert service.faulted
    journal = json.loads(next(service.backup_dir.glob("*.json")).read_text())
    assert journal["status"] == "failed"
    assert journal["changes"][0]["readback"] == 3


def test_unknown_model_not_interpreted_as_xl330(setup):
    bus, service = setup
    bus.registers[30][0] = 999
    with pytest.raises(DeviceError, match="지원하지 않는 모델"):
        service.read_state(30)
    assert bus.writes == []


def test_invalid_ids_and_modified_plan_rejected(setup):
    _, service = setup
    for ids in ([], [30, 30], [-1], [254]):
        with pytest.raises(DeviceError):
            service.read_states(ids)
    plan = service.preview_zero([30])
    with pytest.raises(DeviceError):
        service.apply_zero(replace(plan, offsets=(0,)))
