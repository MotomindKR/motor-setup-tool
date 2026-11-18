# CAN register audit

Audited against the official Classic CAN manuals on 2026-11-18. These are
device permissions; the app exposes a smaller set of editable setup parameters.
Firmware can lag the manual, so a documented parameter may still be rejected
by older firmware. No physical motor or flash writes were used for this audit.

## Addresses and storage

The host computer's **function codes** and the Type 17/18 **CAN indices** are
different namespaces. The old editor sent `0x2011`–`0x2019` as CAN indices.
Use the aliases below. This does not mean every `0x20xx` address is invalid:
the vendor SDK also defines a direct mechanical-offset index at `0x2005`.

| Parameter | CAN index | Host function code | Type | Device access | Storage |
|---|---|---|---|---|---|
| Current Kp | `0x7010` | `0x2012` | float32 | R/W | Save with Type 22 |
| Current Ki | `0x7011` | `0x2013` | float32 | R/W | Save with Type 22 |
| Current filter gain | `0x7014` | `0x2011` | float32 | R/W | Save with Type 22 |
| Speed limit | `0x7017` | `0x2018` | float32 | R/W | Save with Type 22 |
| Current limit | `0x7018` | `0x2019` | float32 | R/W | Save with Type 22 |
| Position Kp | `0x701E` | `0x2016` | float32 | R/W | Save with Type 22 |
| Speed Kp | `0x701F` | `0x2014` | float32 | R/W | Save with Type 22 |
| Speed Ki | `0x7020` | `0x2015` | float32 | R/W | Save with Type 22 |
| Speed filter gain | `0x7021` | `0x2017` | float32 | R/W; RS-05/06: W only | Save with Type 22 |
| Power-on position range | `0x7029` | Varies by model | uint8 | R/W; RS-01: omitted | Save with Type 22; power cycle |
| Position offset | `0x702B` | Varies by model | float32 | R/W; RS-01: omitted | Save with Type 22; power cycle |

Type 18 changes RAM and is lost on power loss. The manual says Type 22 saves
settings corresponding to host function codes beginning `0x20`. It is a
**global parameter save**, not a save of one index: it can also commit other
pending persistent settings. A save acknowledgement and RAM readback do not
prove nonvolatile storage; power cycle and read again to verify it.

The app distinguishes `readable`, `writable`, `editable`, `persistence`, and
model-specific availability in one shared catalog. Protection limits are R/W
on the device but **protected in this editor**. Four telemetry indices are
read only and live. RS-05/06 write-only speed filters are protected because
the editor requires a previous-value read and verified readback. RS-01 zero
range/offset are disabled because its CAN table omits them; SDK-wide presence
is not taken as proof of support on that model.

Gain bounds are 0–200 and filter bounds 0–1 in the host tables. Zero range is
0 or 1; offset is −7 to 7 radians. Protection limits differ by model: for
example RS-00's CAN table limits speed to 33 rad/s and current to 16 A, while
RS-10P uses 13 rad/s and 19 A. Generic host-table example values are not used
as universal limits or defaults.

## Complete single-parameter CAN table

R/W below applies to RS-00–06 and RS-10P unless an exception is listed.
“Save” means mapped to a host `0x20xx` setting under the manual's Type 22 rule.
“Unspecified” means no claim of persistence for that individual index; it is
not offered as a persistent editor setting.

| CAN index | Symbol | Type / bytes | Access | Persistence / purpose |
|---|---|---|---|---|
| `0x7005` | run_mode | uint8 / 1 | R/W | Runtime mode; not saved by app |
| `0x7006` | iq_ref | float32 / 4 | R/W | Runtime current target |
| `0x700A` | spd_ref | float32 / 4 | R/W | Runtime speed target |
| `0x700B` | limit_torque | float32 / 4 | R/W | Save; protected limit |
| `0x7010` | cur_kp | float32 / 4 | R/W | Save |
| `0x7011` | cur_ki | float32 / 4 | R/W | Save |
| `0x7014` | cur_filt_gain | float32 / 4 | R/W | Save |
| `0x7016` | loc_ref | float32 / 4 | R/W | Runtime position target |
| `0x7017` | limit_spd | float32 / 4 | R/W | Save; protected limit |
| `0x7018` | limit_cur | float32 / 4 | R/W | Save; protected limit |
| `0x7019` | mechPos | float32 / 4 | R | Live telemetry |
| `0x701A` | iqf | float32 / 4 | R | Live telemetry |
| `0x701B` | mechVel | float32 / 4 | R | Live telemetry |
| `0x701C` | VBUS | float32 / 4 | R | Live telemetry |
| `0x701E` | loc_kp | float32 / 4 | R/W | Save |
| `0x701F` | spd_kp | float32 / 4 | R/W | Save |
| `0x7020` | spd_ki | float32 / 4 | R/W | Save |
| `0x7021` | spd_filt_gain | float32 / 4 | R/W; RS-05/06 W | Save |
| `0x7022` | acc_rad | float32 / 4 | R/W; RS-05/06 W | Save; velocity acceleration |
| `0x7024` | vel_max | float32 / 4 | R/W; RS-05/06 W | Save; PP speed |
| `0x7025` | acc_set | float32 / 4 | R/W; RS-05/06 W | Save; PP acceleration |
| `0x7026` | EPScan_time | uint16 / 2 | R/W | Reporting interval; unspecified |
| `0x7028` | canTimeout | uint32 / 4 | R/W | Save; communication watchdog |
| `0x7029` | zero_sta | uint8 / 1 | R/W; RS-01 omitted | Save; power-on range |
| `0x702A` | damper | uint8 / 1 | R/W; RS-01/05 omitted | Save; anti-backdrive protection |
| `0x702B` | add_offset | float32 / 4 | R/W; RS-01 omitted | Save; position offset |
| `0x702C` | alveolous_open | uint8 / 1 | R/W | Cogging switch; unspecified |
| `0x702D` | iq_test | uint8 / 1 | R/W | Initialization switch; unspecified |
| `0x702E` | dcc_set | float32 / 4 | R/W | PP deceleration; unspecified |

The host tables also list `0x0000` Name and `0x0001` BarCode as strings,
`0x1000`–`0x1007` firmware/build metadata as read only, and `0x3000`-series
diagnostics as read only. The single-parameter CAN table does not establish
Type 17/18 access or string encoding for every host entry. The app does not
assume those host codes can all be sent directly as CAN indices. BarCode is
not the eight-byte Type 0 actuator UUID recorded by this app.

## Sources

All manuals are pinned at Product_Information commit
[`0f4ad74fdb67023e75bbcbeebecd6f1a003ce000`](https://github.com/RobStride/Product_Information/tree/0f4ad74fdb67023e75bbcbeebecd6f1a003ce000/Product%20Literature).
Page numbers below count PDF pages, including the cover.

| Manual | Host table | CAN table | Type 18 write / Type 22 save |
|---|---|---|---|
| [RS00 260713](https://github.com/RobStride/Product_Information/blob/0f4ad74fdb67023e75bbcbeebecd6f1a003ce000/Product%20Literature/RS00/RS00User%20Manual260713.pdf) | 20–25 | 45–47 | 42–43 |
| [RS01 260713](https://github.com/RobStride/Product_Information/blob/0f4ad74fdb67023e75bbcbeebecd6f1a003ce000/Product%20Literature/RS01/RS01User%20Manual260713.pdf) | 22–27 | 48–50 | 45–46 |
| [RS02 260713](https://github.com/RobStride/Product_Information/blob/0f4ad74fdb67023e75bbcbeebecd6f1a003ce000/Product%20Literature/RS02/RS02User%20Manual260713.pdf) | 21–26 | 49–51 | 45–46 |
| [RS03 260713](https://github.com/RobStride/Product_Information/blob/0f4ad74fdb67023e75bbcbeebecd6f1a003ce000/Product%20Literature/RS03/RS03User%20Manual260713.pdf) | 22–27 | 49–51 | 45–46 |
| [RS04 260713](https://github.com/RobStride/Product_Information/blob/0f4ad74fdb67023e75bbcbeebecd6f1a003ce000/Product%20Literature/RS04/RS04User%20Manual260713.pdf) | 23–28 | 51–53 | 47–48 |
| [RS05 260713](https://github.com/RobStride/Product_Information/blob/0f4ad74fdb67023e75bbcbeebecd6f1a003ce000/Product%20Literature/RS05/RS05User%20Manual260713.pdf) | 23–28 | 53–55 | 49–50 |
| [RS06 260713](https://github.com/RobStride/Product_Information/blob/0f4ad74fdb67023e75bbcbeebecd6f1a003ce000/Product%20Literature/RS06/RS06User%20Manual260713.pdf) | 22–27 | 50–52 | 46–47 |
| [RS10P 260907](https://github.com/RobStride/Product_Information/blob/0f4ad74fdb67023e75bbcbeebecd6f1a003ce000/Product%20Literature/10P/RS10PUser%20Manual260907.pdf) | 20–25 | 45–47 | 42–43 |

The vendor's [Python parameter definitions](https://github.com/RobStride/Python_Sample/blob/cbf977e56c842d57a65f3f17c1b1ecaef002c424/robstride_dynamics/protocol.py)
independently confirm the gain/filter CAN aliases. Its model-range table is
older and does not include RS-10P; model scaling follows the model manuals.

## RS-10P support

The September 7 manual documents the same Classic CAN extended-frame protocol
and parameter types as the existing models. Type 1/2 scaling is ±4π rad,
±13 rad/s, and ±42 Nm (PDF p.39). Kp/Kd fields use 0–500 and 0–5; calibration
commands both as zero. Ratings are 14 Nm continuous with the specified heatsink,
42 Nm peak, 125 rpm no load, 25:1 gearing, 48 V (PDF pp.8–11).

Discovery recognizes the official firmware family `0.10.x.y` as RS-10P.
The vendor's [V26.05.19 release](https://github.com/RobStride/Product_Information/releases/tag/V26.05.19)
now contains `rs10_0.10.0.6.bin` (the asset uses `rs10`, not `rs10p`). The
downloaded 98,300-byte image was checked against the release SHA-256:
`bc396bbd95f768b87743d836603cb4612566b62a72728171daccd3c04e194030`.

The profile uses the existing bench policy: 3.5 Nm torque cutoff and
5.85 rad/s speed cutoff, with the same watchdog and travel protections.
This adds discovery, calibration/plans, test/jog, setup registers, recordings,
and the verified firmware catalog entry. It covers the vendor's private
Classic CAN protocol at 1 Mbps. CAN-FD, CANopen and the separate standard-ID
MIT protocol are not implemented. Hardware operation on a physical RS-10P
has not been verified.
