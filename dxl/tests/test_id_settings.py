"""ID EEPROM changes on a fake bus; no physical devices are opened."""
from dataclasses import replace
import json

import pytest

from dxl_settings.service import SettingsService
from dxl_settings.transport import DemoTransport, DeviceError, check_write


@pytest.fixture
def setup(tmp_path):
    bus = DemoTransport()
    return bus, SettingsService(bus, tmp_path / "backups")


@pytest.mark.parametrize("new_id", [0, 40, 252])
def test_id_change_preserves_calibration_and_other_motors(setup, new_id):
    bus, service = setup
    bus.registers[30][10] = 13
    bus.registers[30][20] = -123 & 0xFFFFFFFF
    before = service.read_state(30)
    untouched = service.read_state(31)
    result = service.set_id(30, new_id)
    assert result.old_id == 30
    assert result.state == replace(before, motor_id=new_id)
    assert service.read_state(31) == untouched
    assert service.read_state(new_id) == result.state
    assert bus.read(new_id, 7, 1) == new_id
    assert bus.ping(30) is None
    assert bus.writes == [(30, 7, 1, new_id)]
    data = json.loads(result.backup_path.read_text())
    assert data["operation"] == "id" and data["status"] == "verified"
    assert data["old_id"] == 30 and data["new_id"] == new_id
    assert data["motors"][0]["motor_id"] == 30
    change = data["changes"][0]
    assert change["before"]["motor_id"] == 30
    assert change["after"]["motor_id"] == change["readback"] == new_id
    assert change["old_id_response"] is None
    # Existing zero/direction controls must work at the new address.
    service.set_direction([new_id], False)
    service.save_zero([new_id])
    assert service.read_state(new_id).position == 2048


@pytest.mark.parametrize("old_id,new_id", [(30, -1), (30, 253), (30, 254), (30, 255),
                                         (30, True), (30, 40.0), (30, "40"),
                                         (-1, 40), (True, 40), (30, 30)])
def test_invalid_or_same_ids_do_not_write(setup, old_id, new_id):
    bus, service = setup
    with pytest.raises(DeviceError):
        service.set_id(old_id, new_id)
    assert bus.writes == [] and not service.backup_dir.exists()


@pytest.mark.parametrize("value", [-1, 253, 254, 256, True, 40.0])
def test_transport_rejects_reserved_or_invalid_id_value(value):
    with pytest.raises(DeviceError):
        check_write(7, 1, value)


@pytest.mark.parametrize("register,value", [(64, 1), (70, 4), (68, 1), (0, 999), (7, 10)])
def test_id_change_checks_source_before_writing(setup, register, value):
    bus, service = setup
    bus.registers[30][register] = value
    with pytest.raises(DeviceError):
        service.set_id(30, 40)
    assert bus.writes == [] and not service.backup_dir.exists()


@pytest.mark.parametrize("target_model", [1200, 999])
def test_occupied_id_is_rejected_even_for_unsupported_device(setup, target_model):
    bus, service = setup
    bus.registers[40] = {0: target_model}
    with pytest.raises(DeviceError, match="이미 사용 중"):
        service.set_id(30, 40)
    assert bus.writes == [] and not service.backup_dir.exists()


def test_ping_error_is_not_treated_as_free_id(setup, monkeypatch):
    bus, service = setup
    def ping(_):
        raise DeviceError("CRC error")
    monkeypatch.setattr(bus, "ping", ping)
    with pytest.raises(DeviceError, match="CRC"):
        service.set_id(30, 40)
    assert bus.writes == [] and not service.backup_dir.exists()


def test_target_occupation_is_rechecked_before_write(setup, monkeypatch):
    bus, service = setup
    original_ping = bus.ping
    calls = []
    def ping(motor_id):
        calls.append(motor_id)
        return None if len(calls) == 1 else 1200
    monkeypatch.setattr(bus, "ping", ping)
    with pytest.raises(DeviceError, match="직전에 사용 중"):
        service.set_id(30, 40)
    assert calls == [40, 40] and bus.writes == []
    assert not service.faulted
    monkeypatch.setattr(bus, "ping", original_ping)
    assert service.set_id(30, 40).state.motor_id == 40


def test_source_config_change_during_id_setup_prevents_write(setup, monkeypatch):
    bus, service = setup
    def ping(_):
        bus.registers[30][10] = 1
        return None
    monkeypatch.setattr(bus, "ping", ping)
    with pytest.raises(DeviceError, match="설정이 바뀌었습니다"):
        service.set_id(30, 40)
    assert bus.writes == []


def test_backup_failure_prevents_id_write(setup, monkeypatch):
    bus, service = setup
    def failed_backup(*_):
        raise OSError("disk full")
    monkeypatch.setattr("dxl_settings.service.atomic_json", failed_backup)
    with pytest.raises(OSError, match="disk full"):
        service.set_id(30, 40)
    assert bus.writes == [] and bus.ping(30) == 1200


@pytest.mark.parametrize("failure", ["write_error_after_apply", "silent_rejection", "bad_readback", "old_id_still_present", "config_changed"])
def test_uncertain_id_write_is_journaled_and_never_retried(setup, monkeypatch, failure):
    bus, service = setup
    original_write, original_ping = bus.write, bus.ping
    attempts = []
    def write(*args):
        attempts.append(args)
        if failure == "silent_rejection":
            return
        original_write(*args)
        if failure == "write_error_after_apply":
            raise DeviceError("lost transport")
        if failure == "bad_readback":
            bus.registers[40][7] = 41
        if failure == "config_changed":
            bus.registers[40][20] = 100
    monkeypatch.setattr(bus, "write", write)
    if failure == "old_id_still_present":
        monkeypatch.setattr(bus, "ping", lambda i: 1200 if i == 30 else original_ping(i))
    with pytest.raises(DeviceError, match="ID 30 → 40가"):
        service.set_id(30, 40)
    assert attempts == [(30, 7, 1, 40)] and service.faulted
    document = json.loads(next(service.backup_dir.glob("*.json")).read_text())
    assert document["status"] == "failed"
    assert document["changes"][0]["before"]["motor_id"] == 30
    if failure != "silent_rejection":
        assert bus.ping(40) == 1200
    with pytest.raises(DeviceError, match="잠겼습니다"):
        service.set_direction([30 if failure == "silent_rejection" else 40], True)
    assert len(attempts) == 1
