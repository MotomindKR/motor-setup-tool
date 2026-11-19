# RobStride protocol reference

[Developer guide](development.md) · [Identification](identification.md)

The app uses RobStride's 29-bit extended Classic CAN frames.

## Wire ranges

Type 1 carries torque in ID bits 8–23 and encodes position, velocity, Kp, and
Kd as big-endian 16-bit payload values. Calibration sets both gains to zero.
Type 2 feedback uses the selected model's wire ranges and reports temperature
in tenths of a degree. Each recording stores the profile used during acquisition.
[Model catalog](../electron/motor-models.json) · [Manufacturer manuals](registers.md#sources)

## Discovery and identity

Discovery probes IDs 1–254, excluding the configured host ID. Type 0 returns
the motor identity. Each responding motor is then queried for its firmware:

- Request: type 4, host in ID bits 8–15, motor in bits 0–7, payload
  `00 C4 00 00 00 00 00 00`. This is a stop-class command.
- Response: type 2, motor as source, host as destination, prefix `00 C4 56`,
  four version components in bytes 3–6.
- Family mapping: `0.N.x.y`, with N from 0 through 6, selects RS-0N; family 10 selects RS-10P. Unknown
  formats remain unknown. Calibration rejects missing or mismatched families.

Version replies are excluded from motion feedback decoding. The recording
captures identity, firmware, and wire profile in `hardware.json`.

## Commands and faults

| Operation | Type / parameter | Behavior |
|---|---|---|
| Enable | Type 3 | Wait for Run feedback; faults abort |
| Stop | Type 4 | Request stopped mode |
| Set zero | Type 6, payload byte 0 = 1 | Stop, require stationary feedback, verify position |
| Change ID | Type 7, new ID in bits 16–23 | Check collision, stop, verify unchanged UUID at the new ID |
| Parameter read | Type 17 reply | Reject nonzero status in ID bits 16–23 |
| Motor fault | Type 21 | Decode little-endian 32-bit fault/warning fields; nonzero faults abort |

Warning-only type-21 reports are not treated as faults. CAN error frames are
received explicitly so bus faults are surfaced before repeated transmissions
fill the queue. A per-user, per-interface file lock excludes simultaneous app
operations; it cannot exclude unrelated CAN tools.

SocketCAN and GS USB share the [Linux CAN error-frame definitions](https://github.com/torvalds/linux/blob/v6.12/include/uapi/linux/can/error.h).
Arbitration loss, controller restart, error-counter updates, and return-to-active
notifications alone do not abort an operation or count as motor feedback. For
example, `20000004#0040000000007f01` reports return to error-active, with TX/RX
error counters 127/1. Those counters still indicate recent bus errors.
Bus-off, acknowledgement/protocol errors, controller warnings/passive state,
overflow, and unknown error classes abort; a recovery flag cannot mask them.

## Calibration preflight and stopping

The app confirms standstill from several stopped-mode reports. Position span
catches drift and reversals, while median speed tolerates an isolated noisy
sample. Missing feedback or a CAN fault aborts the operation. [Standstill check](../src/stationary.rs)

Before applying torque, the app programs the motor watchdog and measures its
expiry with a zero-torque enable. Some firmware reports its state periodically.
Older firmware needs a status request after the quiet interval. The test checks
that the motor returned to Reset before acquisition begins.

The host disables the motor on exit. The firmware watchdog covers loss of host
commands. Encoder continuity checks account for USB replies arriving in a batch,
and store rejected frames in `encoder_error.json`. [Acquisition](../src/hardware.rs) ·
[Encoder timing](../src/encoder.rs)

### Register editor

Use `motor-setup-tool register list --model RS-00` for effective permissions,
including the model's overrides. [Register catalog](../electron/register-catalog.json) ·
[Register addresses and storage](registers.md)

Writes require a stopped motor, UUID and previous raw value from a recent read,
verified readback, and a save acknowledgement. Power cycle and read again to
verify nonvolatile storage. Motion targets, run mode, watchdog settings,
protocol switching, and internal calibration controls are excluded.

## Firmware transfer

The vendor can replace assets under an existing release tag. Downloads are
verified against the pinned image digest. [Firmware catalog](../src/firmware_catalog.json)

The updater implements private CAN types 11–14 following the vendor's
[OTA protocol and reference](https://github.com/RobStride/Product_Information/tree/main/OTA).

Firmware update sequence:

1. Verify image digest, model family, and motor UUID.
2. Send acknowledged 8-byte packets with bounded retries and resume handling.
3. Restart and read back the target version and unchanged UUID.

Transfer acknowledgement alone is not success. Flashing never enables the
motor; it blocks cancellation, window closing, and other operations. Logs are
`firmware_update.json` and `ota_ack.jsonl`.

## Measurement consistency

Acquisition and fitting compare position change with integrated velocity over
200 ms windows once enough motion is available. A scale disagreement above
10% rejects the recording; it never silently rescales data or switches wire
profiles. This check helps detect incompatible position/velocity units but
cannot verify commanded torque accuracy.
