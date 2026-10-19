# RobStride protocol reference

[Developer guide](development.md) · [Identification](identification.md)

The app uses RobStride's 29-bit extended CAN frames. Profiles follow type 1
commands and type 2 feedback from the pinned July 13, 2026 manuals. Wire
ranges below differ from rated specifications and calibration limits.

## Wire ranges

| Model | Speed range (rad/s) | Torque range (Nm) | Pinned source |
|---|---:|---:|---|
| RS00 | ±33 | ±14 | [2026-07-13 manual](https://github.com/RobStride/Product_Information/blob/0f4ad74fdb67023e75bbcbeebecd6f1a003ce000/Product%20Literature/RS00/RS00User%20Manual260713.pdf) |
| RS01 | ±44 | ±17 | [2026-07-13 manual](https://github.com/RobStride/Product_Information/blob/0f4ad74fdb67023e75bbcbeebecd6f1a003ce000/Product%20Literature/RS01/RS01User%20Manual260713.pdf) |
| RS02 | ±44 | ±17 | [2026-07-13 manual](https://github.com/RobStride/Product_Information/blob/0f4ad74fdb67023e75bbcbeebecd6f1a003ce000/Product%20Literature/RS02/RS02User%20Manual260713.pdf) |
| RS03 | ±20 | ±60 | [2026-07-13 manual](https://github.com/RobStride/Product_Information/blob/0f4ad74fdb67023e75bbcbeebecd6f1a003ce000/Product%20Literature/RS03/RS03User%20Manual260713.pdf) |
| RS04 | ±15 | ±120 | [2026-07-13 manual](https://github.com/RobStride/Product_Information/blob/0f4ad74fdb67023e75bbcbeebecd6f1a003ce000/Product%20Literature/RS04/RS04User%20Manual260713.pdf) |
| RS05 | ±50 | ±5.5 | [2026-07-13 manual](https://github.com/RobStride/Product_Information/blob/0f4ad74fdb67023e75bbcbeebecd6f1a003ce000/Product%20Literature/RS05/RS05User%20Manual260713.pdf) |
| RS06 | ±50 | ±36 | [2026-07-13 manual](https://github.com/RobStride/Product_Information/blob/0f4ad74fdb67023e75bbcbeebecd6f1a003ce000/Product%20Literature/RS06/RS06User%20Manual260713.pdf) |
Position ranges are ±4π rad. In type 1, torque occupies ID bits 8–23;
position, velocity, Kp, and Kd are big-endian 16-bit payload values.
Calibration sends Kp = Kd = 0. Feedback uses model-specific ranges, with
temperature as an unsigned 16-bit value divided by ten.

`types::Profile` owns the ranges; saved sessions keep the acquisition profile.
New captures select a model from discovered firmware, not a manual revision.

## Discovery and identity

Discovery probes IDs 1–254, excluding the configured host ID. Type 0 returns
the motor identity. Each responding motor is then queried for its firmware:

- Request: type 4, host in ID bits 8–15, motor in bits 0–7, payload
  `00 C4 00 00 00 00 00 00`. This is a stop-class command.
- Response: type 2, motor as source, host as destination, prefix `00 C4 56`,
  four version components in bytes 3–6.
- Family mapping: `0.N.x.y`, with N from 0 through 6, selects RS-0N. Unknown
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

## Calibration preflight and stopping

Before excitation, the app reads back operation mode `0x7005 = 0` and command
watchdog `0x7028 = 2000` raw ticks. A zero-torque enable must return fault-free
Reset within 300 ms without commands. Periodic type-24 status enables this
quiet check; older firmware gets a zero-torque status request afterward. The
check does not assume a tick duration.

| Check | Limit |
|---|---|
| Enable feedback | Run within 100 ms; intermediate Reset is allowed |
| Missing feedback | 50 ms |
| Missed command deadline | 25 ms |
| During acquisition | State, faults, speed, travel, temperature, encoder continuity, CAN errors |

A stop guard handles exits; the firmware watchdog covers lost host commands.
The desktop command loop is not a hard real-time scheduler.

Encoder continuity compares unwrapped position over 50 ms. It allows 5 ms of
USB/host arrival jitter and 0.02 rad tolerance, with the same speed envelope
against every recent sample. Jitter cannot accumulate packet by packet.
Rejected frames and timing go to `encoder_error.json`; speed, travel, feedback,
and deadline limits remain separate.

Mode/watchdog settings remain in place after capture; the app does not save
them to flash. Scanning and calibration do not change IDs, zero position, or
firmware. Those are separate user-triggered operations.

The Setup register editor reads documented persistent `0x20xx` parameters
using CAN type 17. It writes only gains and filters `0x2011`–`0x2017` using type
18, verifies the readback, then sends the documented type 22 save frame. It
checks motor UUID and the prior raw value before writing. The `0x2018` and
`0x2019` protection limits are read only; volatile `0x70xx` control parameters
cannot be edited. A power cycle is needed to verify nonvolatile storage.

## Firmware transfer

`firmware_catalog.json` pins the model-specific versions, URLs, and SHA-256
hashes from [RobStride release V26.05.19](https://github.com/RobStride/Product_Information/releases/tag/V26.05.19).
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
