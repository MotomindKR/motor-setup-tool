# CAN register audit

## Addresses and storage

Use `motor-setup-tool register list --model RS-00` for the addresses, access
permissions, and persistence supported by the editor. Rust and Electron use
the same model overrides. [Register catalog](../electron/register-catalog.json)

Host function codes and Classic CAN indices are separate address spaces. For
example, the host's current Kp setting maps to CAN index `0x7010`. Type 17
reads an index and Type 18 writes RAM. Type 22 saves **all pending persistent
settings**. Power cycle and read back the value to verify nonvolatile storage.

The editor requires both a prior read and a verified readback. This rules out
write-only settings. Protection limits and live motion targets also stay outside
the editor's write path.

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

The RS-10P uses the vendor's private Classic CAN protocol. Its September manual
documents wire scaling on page 39 and output-side ratings on pages 8–11.
Discovery uses firmware family `0.10.x.y`. The firmware catalog records the
vendor's `rs10` asset name. Physical RS-10P operation remains unverified.
