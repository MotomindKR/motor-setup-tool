# Simulation and exports

[User guide](user-guide.md) · [Fitting method](identification.md)

## Choose an accepted result

Use `calibration.json` and `post_calibration.xml` from an accepted run. A rejected
fit retains `candidate.json` and `candidate.xml` for inspection; these are not
accepted exports. Refit removes stale accepted files if the new result fails
validation.

All mechanical values refer to the **gearbox output shaft**. Estimates assume
commanded torque is accurate. They do not identify torque strength, PD gains,
or the inertia of a robot link attached later.

## Apply the parameters

| Calibration field | MuJoCo setting | Unit |
|---|---|---|
| `parameters.armature` | Joint `armature` | kg m² |
| `parameters.damping` | Joint `damping` | Nm s/rad |
| `parameters.friction` | Joint `frictionloss` | Nm |
| `parameters.delay` | Delay the actuator command in the control/replay loop | s |

The standalone XML uses a direct torque actuator with `gear="1"` and negligible
numerical body inertia. In a robot model, retain the actual link mass/inertia
and avoid counting the motor inertia or friction twice. Adapt actuator scaling
if your robot uses a different transmission convention.

**Loading the XML does not activate delay.** The exported `replay_wrapper.py`
implements delayed torque commands and the stepping behavior used by the app.
The delay estimate includes host, CAN, firmware, and feedback timing. Apply it
once, accounting for delay already present in your control stack.

Example using the exported bare-motor model:

```python
import json
import mujoco
from replay_wrapper import TorqueReplay

with open("calibration.json") as file:
    calibration = json.load(file)
model = mujoco.MjModel.from_xml_path("post_calibration.xml")
data = mujoco.MjData(model)
replay = TorqueReplay(model, data, calibration)

# Timestamps share data.time's origin; torque is in output-shaft Nm.
replay.advance_to(0.01, [(0.0, 0.02)])
```

This optional helper requires Python MuJoCo in your simulation environment. The
calibration app itself runs MuJoCo natively and does not require Python. New
fits use constant `frictionloss`; the helper also supports older saved models
with a separate static-friction peak.

## Run folder reference

| File | Purpose |
|---|---|
| `calibration.json`, `post_calibration.xml` | Accepted parameters and standalone MuJoCo model |
| `candidate.json`, `candidate.xml` | Fitted result, including rejected candidates |
| `pre_calibration.xml` | Baseline simulation model |
| `report.json` | Fit status, parameters, diagnostics, and comparison traces |
| `training.csv`, `validation.csv` | Measured and simulated position/velocity series |
| `session.json` | Recorded commands, feedback, timestamps, and completion flag |
| `config.json` | Motor profile, limits, and baseline used for the run |
| `hardware.json` | Recorded motor identity, firmware, and wire profile |
| `experiment_plan.json` | Motion stages, limits, and model specifications |
| `replay_wrapper.py` | Optional delayed-command replay helper |
| `error.json` | Acquisition failure details, when a run fails |

Interrupted acquisition preserves partial data when available. Incomplete
sessions cannot be fitted. Fitting changes simulation artifacts, not firmware
calibration constants in the motor.
