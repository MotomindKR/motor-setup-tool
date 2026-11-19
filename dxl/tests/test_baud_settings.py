"""Verify baud changes and recovery on a speed-aware fake bus."""
import json
from dataclasses import replace

import pytest

from dxl_settings.service import SettingsService
from dxl_settings.transport import DemoTransport, DeviceError, check_write


@pytest.fixture
def setup(tmp_path):
    bus = DemoTransport(57_600)
    return bus, SettingsService(bus, tmp_path / "backups")


def test_baud_is_written_once_and_verified_at_one_megabit(setup):
    bus, service = setup
    before = service.read_state(30)
    path, after = service.set_1mbps(30)
    assert before.baud_rate == 57_600
    assert replace(before, baud_code=3) == after
    assert after.baud_rate == 1_000_000
    assert bus.baud == 1_000_000
    assert bus.writes == [(30, 8, 1, 3)]
    assert [row.motor_id for row in service.scan()] == [30]
    journal = json.loads(path.read_text())
    assert (journal["old_baud"], journal["new_baud"]) == (57_600, 1_000_000)
    assert journal["changes"][0]["readback"] == 3
    assert journal["status"] == "verified"
    assert service.set_1mbps(30) == (None, after)
    assert len(bus.writes) == 1


@pytest.mark.parametrize("value,size", [(1, 1), (2, 1), (3.0, 1), (3, 2)])
def test_transport_only_accepts_one_megabit_code(value, size):
    with pytest.raises(DeviceError):
        check_write(8, size, value)


@pytest.mark.parametrize("register,value", [(64, 1), (70, 4), (68, 1), (7, 31)])
def test_baud_preflight_rejects_unsafe_or_wrong_motor(setup, register, value):
    bus, service = setup
    bus.registers[30][register] = value
    with pytest.raises(DeviceError):
        service.set_1mbps(30)
    assert bus.baud == 57_600 and bus.writes == []


def test_hardware_baud_change_requires_one_responding_motor(setup):
    bus, service = setup
    bus.simulated = False
    with pytest.raises(DeviceError, match="only one motor"):
        service.set_1mbps(30)
    assert bus.baud == 57_600 and bus.writes == []
    assert not service.faulted
    bus.registers = {30: bus.registers[30]}
    assert service.set_1mbps(30)[1].baud_rate == 1_000_000


def test_same_id_at_target_speed_blocks_change(setup, monkeypatch):
    bus, service = setup
    monkeypatch.setattr(bus, "ping", lambda _: 1200 if bus.baud == 1_000_000 else None)
    with pytest.raises(DeviceError, match="already responds"):
        service.set_1mbps(30)
    assert bus.baud == 57_600 and bus.writes == []
    assert not service.faulted


def test_baud_probe_locks_writes_if_adapter_speed_cannot_be_restored(setup, monkeypatch):
    bus, service = setup
    set_baud = bus.set_baud

    def fail_restore(baud):
        if baud == 57_600:
            raise DeviceError("port reopen failed")
        set_baud(baud)

    monkeypatch.setattr(bus, "set_baud", fail_restore)
    with pytest.raises(DeviceError, match="restore the adapter speed"):
        service.set_1mbps(30)
    assert service.faulted
    assert bus.baud == 1_000_000 and bus.writes == []


def test_baud_backup_failure_prevents_the_write(setup, monkeypatch):
    bus, service = setup
    def fail(*_):
        raise OSError("disk full")
    monkeypatch.setattr("dxl_settings.service.atomic_json", fail)
    with pytest.raises(OSError, match="disk full"):
        service.set_1mbps(30)
    assert bus.baud == 57_600 and bus.writes == []


def test_missing_verification_does_not_retry_or_report_success(setup, monkeypatch):
    bus, service = setup
    original = bus.write
    def write(*args):
        original(*args)
        bus.registers[30][8] = 1  # The motor still responds only at the old speed.
    monkeypatch.setattr(bus, "write", write)
    with pytest.raises(DeviceError, match=r"1000000 bps and the previous speed of 57600"):
        service.set_1mbps(30)
    assert service.faulted
    assert bus.writes == [(30, 8, 1, 3)]
    journal = json.loads(next(service.backup_dir.glob("*.json")).read_text())
    assert journal["status"] == "failed"
    assert journal["changes"][0]["status"] == "writing"
