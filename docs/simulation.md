# Simulation and exports

[User guide](user-guide.md) · [Fitting method](identification.md)

## Choose an accepted result

| Fit status | Files to use |
|---|---|
| Accepted | `calibration.json` and `post_calibration.xml` |
| Rejected | `candidate.json` and `candidate.xml` for inspection only |

Refit removes stale accepted files if validation later fails. All mechanical
values refer to the **gearbox output shaft** and assume accurate commanded
torque. The fit does not identify torque strength, PD gains, or attached link
inertia.

## Apply the parameters

| Calibration field | MuJoCo setting | Unit |
|---|---|---|
| `parameters.armature` | Joint `armature` | kg m² |
| `parameters.damping` | Joint `damping` | Nm s/rad |
| `parameters.friction` | Joint `frictionloss` | Nm |
| `parameters.delay` | Delay the actuator command in the control/replay loop | s |

When adding the fit to a robot model:

- Keep the real link mass and inertia; avoid counting motor inertia or friction twice.
- Adjust actuator scaling if your transmission differs from the standalone
  XML's direct torque actuator (`gear="1"`).
- Apply delay once, accounting for delay already in your control stack.
  **Loading the XML does not activate delay**; `replay_wrapper.py` provides
  the command delay and stepping behavior used by the app.

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

The helper requires Python MuJoCo; the calibration app does not. New fits use
constant `frictionloss`. The helper also reads older models with a separate
static-friction peak.

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

Interrupted acquisition may preserve partial data, but incomplete sessions
cannot be fitted. Fitting changes files, not firmware calibration constants.
