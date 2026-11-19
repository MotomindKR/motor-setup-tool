"""Exercise the installed ROBOTIS SDK over a local pseudo-terminal, no hardware."""
import os
import select
import threading
from math import pi

import pytest

pytestmark = pytest.mark.skipif(not hasattr(os, "openpty"), reason="requires a POSIX PTY")
PacketHandler = pytest.importorskip("dynamixel_sdk").PacketHandler

from dxl_settings.service import SettingsService
from dxl_settings.transport import DemoTransport, DeviceError, SDKTransport
from dxl_settings.worker import Session


class Emulator:
    def __init__(self):
        self.master, self.slave = os.openpty()
        self.port = os.ttyname(self.slave)
        self.bus = DemoTransport()
        self.bus.registers = {30: self.bus.registers[30]}
        self.packet = PacketHandler(2.0)
        self.stop = threading.Event()
        self.requests = []
        self.drop_write_reply = False
        self.corrupt_reply = False
        self.id_write_ack = "new"
        self.reject_id_write = False
        self.thread = threading.Thread(target=self.run, daemon=True)
        self.thread.start()

    def close(self):
        self.stop.set()
        self.thread.join(timeout=2)
        os.close(self.master)
        os.close(self.slave)

    def reply(self, motor_id, payload):
        error = 0x80 if self.bus.registers.get(motor_id, {}).get(70) else 0
        body = bytes([0x55, error]) + payload
        body = body.replace(b"\xff\xff\xfd", b"\xff\xff\xfd\xfd")
        length = len(body) + 2
        packet = b"\xff\xff\xfd\x00" + bytes([motor_id]) + length.to_bytes(2, "little") + body
        crc = self.packet.updateCRC(0, packet, len(packet))
        if self.corrupt_reply:
            crc ^= 1
        os.write(self.master, packet + crc.to_bytes(2, "little"))

    def handle(self, frame):
        motor_id = frame[4]
        body = frame[7:-2].replace(b"\xff\xff\xfd\xfd", b"\xff\xff\xfd")
        instruction, params = body[0], body[1:]
        self.requests.append((motor_id, instruction, params))
        if instruction == 1:
            for i, model in self.bus.scan().items():
                if motor_id in (i, 254):
                    self.reply(i, model.to_bytes(2, "little") + bytes([self.bus.registers[i][6]]))
        elif instruction == 2 and motor_id in self.bus.registers:
            address = int.from_bytes(params[:2], "little")
            size = int.from_bytes(params[2:4], "little")
            value = self.bus.read(motor_id, address, size)
            self.reply(motor_id, value.to_bytes(size, "little"))
        elif instruction == 3 and motor_id in self.bus.registers:
            address = int.from_bytes(params[:2], "little")
            value = int.from_bytes(params[2:], "little")
            if address != 7 or not self.reject_id_write:
                self.bus.write(motor_id, address, len(params) - 2, value)
            if not self.drop_write_reply and not (address == 7 and self.id_write_ack == "none"):
                reply_id = value if address == 7 and self.id_write_ack == "new" and not self.reject_id_write else motor_id
                self.reply(reply_id, b"")

    def run(self):
        buffer = b""
        while not self.stop.is_set():
            ready, _, _ = select.select([self.master], [], [], 0.05)
            if not ready:
                continue
            buffer += os.read(self.master, 4096)
            while len(buffer) >= 7:
                start = buffer.find(b"\xff\xff\xfd\x00")
                if start < 0:
                    buffer = buffer[-3:]
                    break
                buffer = buffer[start:]
                if len(buffer) < 7:
                    break
                size = int.from_bytes(buffer[5:7], "little") + 7
                if len(buffer) < size:
                    break
                self.handle(buffer[:size])
                buffer = buffer[size:]


@pytest.fixture
def wire(tmp_path, monkeypatch):
    # The emulator is scheduled as a test thread rather than a UART device.
    # Allow for CI scheduling delays without changing production timeouts.
    monkeypatch.setattr("dynamixel_sdk.port_handler.LATENCY_TIMER", 60)
    emulator = Emulator()
    transport = SDKTransport(emulator.port, 115200)
    service = SettingsService(transport, tmp_path / "backups")
    try:
        yield emulator, service
    finally:
        service.close()
        emulator.close()


def test_real_sdk_scan_zero_direction_and_signed_bytes(wire):
    emulator, service = wire
    assert [s.motor_id for s in service.scan()] == [30]
    assert emulator.bus.writes == []
    emulator.bus.physical[30] = 2500
    emulator.bus.registers[30][10] = 12
    service.set_direction([30], True)
    service.apply_zero(service.preview_zero([30]))
    state = service.read_state(30)
    assert state.drive_mode == 13
    assert state.position == 2048 and state.joint_radians == 0
    assert state.homing_offset == -453
    writes = [params for _, instruction, params in emulator.requests if instruction == 3]
    assert writes[-1] == b"\x14\x00" + (-453 & 0xFFFFFFFF).to_bytes(4, "little")
    assert all(address in (10, 20) for _, address, _, _ in emulator.bus.writes)
    assert service.transport.port.ser.exclusive is True


def test_sdk_fixed_pi_reference_and_negative_joint_angle(wire):
    emulator, service = wire
    service.apply_zero(service.preview_zero([30]))
    state = service.read_state(30)
    assert state.position == 2048 and state.radians == pytest.approx(pi)
    assert state.joint_radians == state.joint_degrees == 0
    assert state.homing_offset == 298
    assert state.operating_mode == 5 and state.torque == 0
    writes = [params for _, instruction, params in emulator.requests if instruction == 3]
    assert writes == [b"\x14\x00" + (298).to_bytes(4, "little")]
    emulator.bus.physical[30] -= 256
    state = service.read_state(30)
    assert state.position == 1792 and state.radians > 0
    assert state.joint_radians < 0 and state.joint_degrees == -22.5


def test_sdk_writes_and_reads_back_operating_mode_five(wire):
    emulator, service = wire
    emulator.bus.registers[30][11] = 3
    _, (state,) = service.set_mode5([30])
    assert state.operating_mode == 5 and state.torque == 0
    writes = [params for _, instruction, params in emulator.requests if instruction == 3]
    assert writes == [b"\x0b\x00\x05"]


def test_sdk_verifies_baud_change_without_waiting_for_old_speed_ack(wire, monkeypatch):
    emulator, service = wire
    transport = service.transport
    emulator.bus.registers[30][8] = 2
    emulator.bus.set_baud(115_200)
    emulator.drop_write_reply = True
    speeds = []

    def set_baud(baud):
        # A PTY does not model UART timing. Switch which simulated devices can reply.
        speeds.append(baud)
        emulator.bus.set_baud(baud)
        transport.baud = baud

    monkeypatch.setattr(transport, "set_baud", set_baud)
    _, state = service.set_1mbps(30)
    assert state.motor_id == 30 and transport.baud == 1_000_000
    assert speeds == [1_000_000, 115_200, 1_000_000]
    writes = [params for _, instruction, params in emulator.requests if instruction == 3]
    assert writes == [b"\x08\x00\x03"]


def test_sdk_initial_scan_falls_back_to_factory_baud_after_no_reply(wire, monkeypatch):
    emulator, service = wire
    transport = service.transport
    emulator.bus.registers[30][8] = 1
    speeds = []

    def set_baud(baud):
        speeds.append(baud)
        emulator.bus.set_baud(baud)
        transport.baud = baud

    def open_transport(_port, baud):
        set_baud(baud)
        return transport

    monkeypatch.setattr(transport, "set_baud", set_baud)
    monkeypatch.setattr("dxl_settings.worker.SDKTransport", open_transport)
    result = Session(service.backup_dir).execute("connect", {"port": emulator.port, "baud": 1_000_000, "demo": False})
    assert speeds == [1_000_000, 57_600]
    assert result["baud"] == result["motors"][0]["baud_rate"] == 57_600
    assert not emulator.bus.writes


def test_sdk_crc_error_stops_without_writing(wire):
    emulator, service = wire
    emulator.corrupt_reply = True
    with pytest.raises(DeviceError):
        service.set_direction([30], True)
    assert emulator.bus.writes == []


def test_sdk_missing_write_ack_is_uncertain_and_latches_fault(wire):
    emulator, service = wire
    emulator.drop_write_reply = True
    with pytest.raises(DeviceError, match="일부 값"):
        service.set_direction([30], True)
    assert emulator.bus.registers[30][10] == 1
    assert service.faulted


def test_sdk_hardware_alert_visible_and_torque_off_available(wire):
    emulator, service = wire
    emulator.bus.registers[30][70] = 4
    emulator.bus.registers[30][64] = 1
    assert service.read_state(30).hardware_error == 4
    with pytest.raises(DeviceError):
        service.set_direction([30], True)
    service.torque_off([30])
    assert service.read_state(30).torque == 0


@pytest.mark.parametrize("ack", ["old", "new", "none"])
@pytest.mark.parametrize("new_id", [0, 40, 252])
def test_sdk_id_change_verified_with_old_new_or_missing_ack(wire, ack, new_id):
    emulator, service = wire
    emulator.id_write_ack = ack
    before = service.read_state(30)
    result = service.set_id(30, new_id)
    assert result.state.motor_id == new_id
    assert result.state.position == before.position
    assert result.state.homing_offset == before.homing_offset
    assert service.transport.read(new_id, 7, 1) == new_id
    assert service.transport.ping(30) is None
    assert emulator.bus.writes == [(30, 7, 1, new_id)]
    assert [p for _, instruction, p in emulator.requests if instruction == 3] == [b"\x07\x00" + bytes([new_id])]


def test_sdk_refused_id_write_is_not_verified(wire):
    emulator, service = wire
    emulator.reject_id_write = True
    with pytest.raises(DeviceError, match="ID 저장 중단"):
        service.set_id(30, 40)
    assert service.faulted
    assert service.transport.ping(30) == 1200
    assert service.transport.ping(40) is None
    assert len([r for r in emulator.requests if r[1] == 3]) == 1


def test_sdk_ping_corruption_is_not_a_free_destination(wire):
    emulator, service = wire
    emulator.corrupt_reply = True
    with pytest.raises(DeviceError):
        service.transport.ping(30)
    assert emulator.bus.writes == []


@pytest.mark.parametrize("motor_id", [-1, 253, 254, True])
def test_sdk_never_broadcasts_id_write(wire, motor_id):
    emulator, service = wire
    with pytest.raises(DeviceError, match="단일 모터"):
        service.transport.write(motor_id, 7, 1, 40)
    assert emulator.requests == []
