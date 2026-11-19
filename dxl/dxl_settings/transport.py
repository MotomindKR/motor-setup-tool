"""Protocol 2.0 adapter and an explicit, separate in-memory demo bus."""
from __future__ import annotations

from typing import Protocol

from .messages import translate

OPERATING_MODE_ADDRESS = 11
CURRENT_BASED_POSITION_MODE = 5
BAUD_RATE_ADDRESS = 8
BAUD_RATES = (9_600, 57_600, 115_200, 1_000_000, 2_000_000, 3_000_000, 4_000_000)
FACTORY_BAUD = BAUD_RATES[1]
TARGET_BAUD_CODE = 3
TARGET_BAUD = BAUD_RATES[TARGET_BAUD_CODE]


class DeviceError(RuntimeError):
    def __init__(self, message, **values):
        super().__init__(translate(message, **values))


def signed(value: int, bits: int) -> int:
    return value - (1 << bits) if value & (1 << (bits - 1)) else value


class Transport(Protocol):
    simulated: bool
    baud: int

    def set_baud(self, baud: int) -> None: ...
    def scan(self) -> dict[int, int]: ...
    def ping(self, motor_id: int) -> int | None: ...
    def read(self, motor_id: int, address: int, size: int) -> int: ...
    def write(self, motor_id: int, address: int, size: int, value: int) -> None: ...
    def close(self) -> None: ...


def check_write(address: int, size: int, value: int) -> None:
    # No goals, torque ON, or limit writes.
    if (address, size) not in ((7, 1), (BAUD_RATE_ADDRESS, 1), (10, 1), (OPERATING_MODE_ADDRESS, 1), (20, 4), (64, 1)):
        raise DeviceError("Write blocked at address {address} (size {size})", address=address, size=size)
    if address == 7 and (type(value) is not int or not 0 <= value <= 252):
        raise DeviceError("Choose a motor ID from 0 to 252.")
    if address == OPERATING_MODE_ADDRESS and (type(value) is not int or value != CURRENT_BASED_POSITION_MODE):
        raise DeviceError("Only operating mode 5 can be saved.")
    if address == BAUD_RATE_ADDRESS and (type(value) is not int or value != TARGET_BAUD_CODE):
        raise DeviceError("Only 1,000,000 bps can be saved.")
    if address == 64 and value != 0:
        raise DeviceError("This tool cannot enable torque.")


class SDKTransport:
    simulated = False

    def __init__(self, port: str, baud: int):
        try:
            from dynamixel_sdk import PacketHandler, PortHandler
        except ImportError as exc:
            raise DeviceError("The Dynamixel SDK is missing.") from exc
        self.port = PortHandler(port)
        self.packet = PacketHandler(2.0)
        self.set_baud(baud)

    def set_baud(self, baud: int) -> None:
        try:
            # setBaudRate opens the port itself. Avoid opening at the SDK default
            # baud and immediately closing/reopening the same USB device.
            if not self.port.setBaudRate(baud):
                raise DeviceError("Could not set the port speed to {baud} bps.", baud=baud)
            serial_port = getattr(self.port, "ser", None)
            if serial_port is not None and hasattr(serial_port, "exclusive"):
                serial_port.exclusive = True
            self.baud = baud
        except Exception:
            # The SDK's closePort calls ser.close() even when open failed and
            # ser is still None. Cleanup must never hide the original error.
            try:
                self.close()
            except Exception:
                pass
            raise

    def _check(self, comm: int, error: int = 0, context: str = "") -> None:
        if comm != 0:
            raise DeviceError(f"{context}: {self.packet.getTxRxResult(comm)}")
        if error:
            raise DeviceError(f"{context}: {self.packet.getRxPacketError(error)}")

    def scan(self) -> dict[int, int]:
        from dynamixel_sdk import COMM_RX_TIMEOUT
        devices, comm = self.packet.broadcastPing(self.port)
        if comm == COMM_RX_TIMEOUT:
            return {}
        self._check(comm, context=translate("Scan for motors"))
        return {motor_id: info[0] for motor_id, info in devices.items()}

    def ping(self, motor_id: int) -> int | None:
        from dynamixel_sdk import COMM_RX_TIMEOUT
        if type(motor_id) is not int or not 0 <= motor_id <= 252:
            raise DeviceError("Choose a motor ID from 0 to 252.")
        model, comm, error = self.packet.ping(self.port, motor_id)
        if comm == COMM_RX_TIMEOUT:
            return None  # No response; CRC and other communication errors raise.
        self._check(comm, error & 0x7F, translate("ID {motor_id}: ping", motor_id=motor_id))
        return model

    def read(self, motor_id: int, address: int, size: int) -> int:
        method = getattr(self.packet, f"read{size}ByteTxRx")
        value, comm, error = method(self.port, motor_id, address)
        # An alert alone still carries valid read data. Surface Hardware Error(70)
        # in MotorState so the user can inspect it and request torque OFF.
        self._check(comm, error & 0x7F, translate("ID {motor_id}: read register {address}", motor_id=motor_id, address=address))
        return value

    def write(self, motor_id: int, address: int, size: int, value: int) -> None:
        check_write(address, size, value)
        if address in (7, BAUD_RATE_ADDRESS, OPERATING_MODE_ADDRESS) and (type(motor_id) is not int or not 0 <= motor_id <= 252):
            raise DeviceError("Select a single motor ID from 0 to 252.")
        if address in (7, BAUD_RATE_ADDRESS):
            # Identity and baud changes are verified after switching the address or port speed.
            comm = self.packet.write1ByteTxOnly(self.port, motor_id, address, value)
            self._check(comm, context=translate(
                "ID {motor_id}: write register {address}; verify the stored value",
                motor_id=motor_id,
                address=address,
            ))
            if address == BAUD_RATE_ADDRESS:
                self.port.ser.flush()
            return
        method = getattr(self.packet, f"write{size}ByteTxRx")
        comm, error = method(self.port, motor_id, address, value & ((1 << (size * 8)) - 1))
        self._check(comm, error & 0x7F if address == 64 else error,
                    translate(
                        "ID {motor_id}: write register {address}; verify the stored value",
                        motor_id=motor_id,
                        address=address,
                    ))

    def close(self) -> None:
        if getattr(self.port, "ser", None) is not None:
            self.port.closePort()


class DemoTransport:
    """Register-shaped fake, never a fallback after a hardware error.

    Reverse offset response models the observed XL330 firmware-53 Mode 5 behavior.
    This is a test model, not physical validation of the corrected calculation.
    """
    simulated = True

    def __init__(self, baud=TARGET_BAUD):
        self.registers = {}
        self.physical = {}
        self.writes = []
        self.closed = False
        self.baud = baud
        for index, motor_id in enumerate(range(30, 37)):
            self.registers[motor_id] = {
                0: 1190 if index == 6 else 1200, 6: 53, 7: motor_id,
                BAUD_RATE_ADDRESS: BAUD_RATES.index(baud),
                10: 0, OPERATING_MODE_ADDRESS: 3 if index == 6 else CURRENT_BASED_POSITION_MODE,
                20: 0, 48: 4095, 52: 0,
                64: 0, 68: 2, 70: 0, 126: 0, 144: 50, 146: 25,
            }
            self.physical[motor_id] = 1750 + index * 80

    def set_baud(self, baud: int) -> None:
        if self.closed or baud not in BAUD_RATES:
            raise DeviceError("Could not set the port speed to {baud} bps.", baud=baud)
        self.baud = baud

    def scan(self) -> dict[int, int]:
        if self.closed:
            raise DeviceError("The connection is closed.")
        return {i: r[0] for i, r in self.registers.items()
                if BAUD_RATES[r.get(BAUD_RATE_ADDRESS, TARGET_BAUD_CODE)] == self.baud}

    def ping(self, motor_id: int) -> int | None:
        if self.closed:
            raise DeviceError("The connection is closed.")
        if type(motor_id) is not int or not 0 <= motor_id <= 252:
            raise DeviceError("Choose a motor ID from 0 to 252.")
        return self.scan().get(motor_id)

    def read(self, motor_id: int, address: int, size: int) -> int:
        if self.closed:
            raise DeviceError("The connection is closed.")
        try:
            regs = self.registers[motor_id]
            if BAUD_RATES[regs[BAUD_RATE_ADDRESS]] != self.baud:
                raise DeviceError("ID {motor_id}: no response at {baud} bps", motor_id=motor_id, baud=self.baud)
            if address == 132:
                raw = self.physical[motor_id] + signed(regs[20], 32)
                if regs[10] & 1:
                    raw = 4095 - raw
                value = raw
            else:
                value = regs[address]
            return value & ((1 << (size * 8)) - 1)
        except KeyError as exc:
            raise DeviceError("ID {motor_id}: register {address} is unavailable", motor_id=motor_id, address=address) from exc

    def write(self, motor_id: int, address: int, size: int, value: int) -> None:
        check_write(address, size, value)
        if address in (7, BAUD_RATE_ADDRESS, OPERATING_MODE_ADDRESS) and (type(motor_id) is not int or not 0 <= motor_id <= 252):
            raise DeviceError("Select a single motor ID from 0 to 252.")
        if self.closed:
            raise DeviceError("The connection is closed.")
        regs = self.registers[motor_id]
        if BAUD_RATES[regs[BAUD_RATE_ADDRESS]] != self.baud:
            raise DeviceError("ID {motor_id}: no response at {baud} bps", motor_id=motor_id, baud=self.baud)
        if address != 64 and regs[64]:
            raise DeviceError("ID {motor_id}: turn torque off first", motor_id=motor_id)
        if address == 7:
            if value != motor_id and value in self.registers:
                raise DeviceError("ID {value} is already in use.", value=value)
            regs[7] = value
            self.registers[value] = self.registers.pop(motor_id)
            self.physical[value] = self.physical.pop(motor_id)
            self.writes.append((motor_id, address, size, value))
            return
        regs[address] = value & ((1 << (size * 8)) - 1)
        self.writes.append((motor_id, address, size, value))

    def close(self) -> None:
        self.closed = True
