"""Serialized JSON-line interface for the Electron main process."""
from dataclasses import asdict
import json
from pathlib import Path
import sys

from dxl_settings.messages import language
from dxl_settings.service import NoSupportedMotors, SettingsService
from dxl_settings.transport import FACTORY_BAUD, TARGET_BAUD, DemoTransport, DeviceError, SDKTransport


def motor_view(state):
    return {**asdict(state), "name": state.name, "reverse": state.reverse, "baud_rate": state.baud_rate,
            "radians": state.radians, "degrees": state.degrees,
            "joint_radians": state.joint_radians, "joint_degrees": state.joint_degrees}


class Session:
    def __init__(self, backup_dir):
        self.backup_dir = backup_dir
        self.service = None

    def close(self):
        service, self.service = self.service, None
        if service:
            service.close()

    def execute(self, operation, params):
        if operation == "ports":
            from serial.tools.list_ports import comports
            return {"ports": sorted({port.device for port in comports()})}
        if operation == "disconnect":
            self.close()
            return {}
        if operation == "connect":
            if self.service:
                raise DeviceError("Disconnect the current Dynamixel session first.")
            demo, port, baud = params.get("demo", False), params.get("port"), params.get("baud")
            if type(demo) is not bool or not isinstance(port, str) or type(baud) is not int:
                raise DeviceError("Check the Dynamixel connection settings.")
            if not demo and (not port or baud <= 0):
                raise DeviceError("Enter a serial port and baud rate.")
            transport = DemoTransport(FACTORY_BAUD) if demo else SDKTransport(port, baud)
            service = SettingsService(transport, self.backup_dir)
            alternate = {TARGET_BAUD: FACTORY_BAUD, FACTORY_BAUD: TARGET_BAUD}.get(baud)
            speeds = (transport.baud, alternate) if not demo and alternate else (transport.baud,)
            try:
                for speed in speeds:
                    if speed != transport.baud:
                        transport.set_baud(speed)
                    try:
                        states = service.scan()
                    except NoSupportedMotors:
                        continue
                    break
                else:
                    checked = " / ".join(f"{speed:,}" for speed in speeds)
                    raise NoSupportedMotors(
                        "No XL330 found at {speeds} bps. Check the port and motor power.", speeds=checked
                    )
            except Exception:
                try:
                    service.close()
                except Exception:
                    pass
                raise
            self.service = service
            return {"motors": [motor_view(state) for state in states], "demo": demo, "baud": transport.baud}

        service = self.service
        if not service:
            raise DeviceError("Connect a Dynamixel motor first.")
        if operation == "scan":
            return {"motors": [motor_view(state) for state in service.scan()]}
        if operation == "poll":
            return {"motors": [motor_view(state) for state in service.read_states(params["ids"])]}
        ids = params["ids"]
        if not isinstance(ids, list) or not ids or any(type(i) is not int or not 0 <= i <= 252 for i in ids):
            raise DeviceError("Choose a motor ID from 0 to 252.")
        if operation == "export":
            return {"path": str(service.export(ids, Path(params["path"])))}
        if operation == "setMode5":
            path, states = service.set_mode5(ids)
            return {"path": str(path) if path is not None else None,
                    "motors": [motor_view(state) for state in states]}
        if operation == "set1Mbps":
            if len(ids) != 1:
                raise DeviceError("Select one motor to change its baud rate.")
            path, state = service.set_1mbps(ids[0])
            return {"path": str(path) if path is not None else None,
                    "baud": service.transport.baud, "motors": [motor_view(state)]}
        if operation == "saveZero":
            return {"path": str(service.save_zero(ids))}
        if operation == "direction":
            return {"path": str(service.set_direction(ids, params["reverse"]))}
        if operation == "setId":
            if len(ids) != 1:
                raise DeviceError("Select one motor to change its ID.")
            result = service.set_id(ids[0], params["newId"])
            return {"oldId": result.old_id, "motor": motor_view(result.state),
                    "path": str(result.backup_path)}
        if operation == "torqueOff":
            service.torque_off(ids)
            return {}
        if operation == "restore":
            return {"path": str(service.restore(ids, Path(params["path"])))}
        raise DeviceError("Unknown Dynamixel operation.")


def main():
    sys.stdin.reconfigure(encoding="utf-8")
    sys.stdout.reconfigure(encoding="utf-8")
    session = Session(Path(sys.argv[1]))
    try:
        for line in sys.stdin:
            try:
                request = json.loads(line)
                with language(request.get("language")):
                    result = session.execute(request["operation"], request["params"])
                response = {"result": result}
            except Exception as error:
                response = {"error": str(error) or type(error).__name__}
            response["connected"] = session.service is not None
            response["faulted"] = bool(session.service and session.service.faulted)
            print(json.dumps(response, allow_nan=False), flush=True)
    finally:
        session.close()


if __name__ == "__main__":
    main()
