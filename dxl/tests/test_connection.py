"""SDK connection failures and cleanup without hardware."""
from types import SimpleNamespace

import pytest
import dynamixel_sdk
from serial import SerialException

from dxl_settings.service import NoSupportedMotors
from dxl_settings.transport import DemoTransport, DeviceError, SDKTransport
from dxl_settings.worker import Session


def test_failed_port_open_preserves_original_error(tmp_path):
    missing = str(tmp_path / "missing-serial-device")
    with pytest.raises(SerialException, match="missing-serial-device"):
        SDKTransport(missing, 1000000)


def test_unsupported_baud_without_serial_handle():
    with pytest.raises(DeviceError, match="통신 속도 설정 실패"):
        SDKTransport("unused-port", 12345)


def test_constructor_opens_once_and_close_is_repeatable(monkeypatch):
    calls = []
    class Port:
        ser = None

        def __init__(self, name):
            calls.append(("port", name))

        def setBaudRate(self, baud):
            calls.append(("open", baud))
            self.ser = SimpleNamespace(exclusive=False)
            return True

        def closePort(self):
            calls.append(("close",))
            self.ser = None
    monkeypatch.setattr(dynamixel_sdk, "PortHandler", Port)
    transport = SDKTransport("/dev/ttyACM0", 1000000)
    assert calls == [("port", "/dev/ttyACM0"), ("open", 1000000)]
    assert transport.port.ser.exclusive
    transport.close()
    transport.close()
    assert calls[-1] == ("close",)


def test_cleanup_error_does_not_mask_open_failure(monkeypatch):
    class Port:
        def __init__(self, name):
            self.ser = SimpleNamespace(exclusive=False)

        def setBaudRate(self, baud):
            raise SerialException("original open failure")

        def closePort(self):
            raise RuntimeError("cleanup failure")
    monkeypatch.setattr(dynamixel_sdk, "PortHandler", Port)
    with pytest.raises(SerialException, match="original open failure"):
        SDKTransport("fake-port", 1000000)


@pytest.mark.parametrize("preferred,actual,scans", [
    (1_000_000, 57_600, [1_000_000, 57_600]),
    (1_000_000, 1_000_000, [1_000_000]),
    (57_600, 1_000_000, [57_600, 1_000_000]),
    (115_200, 115_200, [115_200]),
])
def test_connect_discovers_xl330_at_the_preferred_or_alternate_speed(tmp_path, monkeypatch, preferred, actual, scans):
    bus = DemoTransport(actual)
    bus.set_baud(preferred)
    scanned = []
    original = bus.scan

    def scan():
        scanned.append(bus.baud)
        return original()

    monkeypatch.setattr(bus, "scan", scan)
    monkeypatch.setattr("dxl_settings.worker.SDKTransport", lambda *_: bus)
    session = Session(tmp_path)
    result = session.execute("connect", {"port": "adapter", "baud": preferred, "demo": False})
    assert result["baud"] == actual
    assert {motor["baud_rate"] for motor in result["motors"]} == {actual}
    assert scanned == scans
    assert not bus.writes
    session.close()


@pytest.mark.parametrize("preferred,expected", [
    (1_000_000, "1,000,000 / 57,600"),
    (115_200, "115,200"),
])
def test_unsuccessful_discovery_reports_checked_speeds_and_closes_port(tmp_path, monkeypatch, preferred, expected):
    bus = DemoTransport(preferred)
    bus.registers.clear()
    monkeypatch.setattr("dxl_settings.worker.SDKTransport", lambda *_: bus)
    session = Session(tmp_path)
    with pytest.raises(NoSupportedMotors, match=expected):
        session.execute("connect", {"port": "adapter", "baud": preferred, "demo": False})
    assert bus.closed and session.service is None


def test_bus_error_closes_the_port_and_preserves_original_error(tmp_path, monkeypatch):
    bus = DemoTransport()

    def scan():
        raise DeviceError("CRC error")

    monkeypatch.setattr(bus, "scan", scan)
    monkeypatch.setattr("dxl_settings.worker.SDKTransport", lambda *_: bus)
    session = Session(tmp_path)
    with pytest.raises(DeviceError, match="CRC error"):
        session.execute("connect", {"port": "adapter", "baud": 1_000_000, "demo": False})
    assert bus.baud == 1_000_000
    assert bus.closed and session.service is None
