"""Reference MuJoCo wrapper for exported delay and Stribeck friction.

The Rust app has no Python dependency. This optional robot-side helper requires
the mujoco Python package. Compile the XML with the exported armature/damping/
kinetic friction before creating data; XML alone omits delay and the static peak.
Commands are output-shaft Nm, with gear=1. This helper advances the entire model.
"""
import bisect
import math


class TorqueReplay:
    def __init__(self, model, data, artifact, joint="motor_joint", actuator="torque"):
        import mujoco
        self.mj, self.model, self.data = mujoco, model, data
        j = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_JOINT, joint)
        a = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_ACTUATOR, actuator)
        if j < 0 or a < 0:
            raise ValueError("Named joint/actuator missing")
        self.dof, self.actuator = int(model.jnt_dofadr[j]), a
        self.p = artifact["parameters"]
        if not math.isclose(model.dof_armature[self.dof], self.p["armature"], rel_tol=1e-8, abs_tol=1e-12):
            raise ValueError("Compile the model with exported armature before using the wrapper")
        if not math.isclose(model.dof_damping[self.dof], self.p["damping"], rel_tol=1e-8, abs_tol=1e-12):
            raise ValueError("Model damping differs from calibration")
        if model.actuator_trnid[a, 0] != j or model.actuator_gear[a, 0] != 1:
            raise ValueError("Use a direct torque motor on the selected joint with gear=1")
        self.speed = artifact.get("friction_model", {}).get("speed_rad_s", 0.1)

    def advance_to(self, end, commands):
        """commands: increasing (host-time seconds, output-shaft Nm) pairs."""
        times = [c[0] for c in commands]
        if any(b <= a for a, b in zip(times, times[1:])):
            raise ValueError("Command times must increase")
        if end < self.data.time:
            raise ValueError("Cannot advance backwards")
        delay = self.p["delay"]
        index = bisect.bisect_right(times, self.data.time - delay + 1e-10)
        torque = commands[index-1][1] if index else 0.0
        original_step = self.model.opt.timestep
        try:
            while self.data.time < end - 1e-10:
                while index < len(commands) and times[index] + delay <= self.data.time + 1e-10:
                    torque = commands[index][1]
                    index += 1
                boundary = min(end, self.data.time + 0.001)
                if index < len(commands):
                    boundary = min(boundary, times[index] + delay)
                h = boundary - self.data.time
                if h <= 1e-10:
                    continue
                self.model.opt.timestep = h
                fc = self.p["friction"]
                fs = max(fc, self.p.get("static_friction", 0.0))
                v = self.data.qvel[self.dof]
                self.model.dof_frictionloss[self.dof] = fc + (fs-fc)*math.exp(-(v/self.speed)**2)
                self.data.ctrl[self.actuator] = torque
                self.mj.mj_step(self.model, self.data)
        finally:
            self.model.opt.timestep = original_step
