//! MuJoCo-rs simulation. Each replay compiles its own model so constant-inertia
//! caches cannot retain a previous armature value. No Python or subprocesses.
#[cfg(test)]
use crate::protocol;
use crate::types::*;
use anyhow::{Result, ensure};
use mujoco_rs::prelude::{MjData, MjModel};
use std::sync::atomic::{AtomicBool, Ordering};

pub const TIMESTEP: f64 = 0.001;
pub const VERSION: &str = "3.12.0";
pub const STRIBECK_SPEED: f64 = 0.1;
pub fn self_check() -> Result<()> {
    let p = Config::default().baseline;
    let mut d = data(&p)?;
    d.forward();
    d.step();
    ensure!(
        d.time() > 0. && d.qpos()[0].is_finite(),
        "MuJoCo self-check failed"
    );
    Ok(())
}
pub fn friction_at_speed(p: &Parameters, velocity: f64) -> f64 {
    p.friction
        + (p.static_friction - p.friction).max(0.) * (-(velocity / STRIBECK_SPEED).powi(2)).exp()
}

pub fn xml(p: &Parameters) -> String {
    format!(
        r#"<mujoco model="bare_motor_calibration">
  <option timestep="0.001" gravity="0 0 0" integrator="implicitfast"/>
  <custom><numeric name="static_friction" data="{}"/>
    <numeric name="stribeck_speed" data="0.1"/>
    <numeric name="effective_delay" data="{}"/></custom>
  <worldbody>
    <body name="output_shaft">
      <!-- Numerical placeholder only; robot link inertia belongs in its body. -->
      <inertial pos="0 0 0" mass="0.001" diaginertia="1e-12 1e-12 1e-12"/>
      <joint name="motor_joint" type="hinge" axis="0 0 1"
             armature="{}" damping="{}" frictionloss="{}" solreffriction="0.004 1"/>
      <geom type="cylinder" size="0.04 0.02" mass="0" contype="0" conaffinity="0"/>
    </body>
  </worldbody>
  <actuator><motor name="torque" joint="motor_joint" gear="1"/></actuator>
  <!-- Delay {} s requires the exported replay wrapper. Historical nonzero static
       peaks also require it. New fits use constant joint frictionloss. -->
</mujoco>
"#,
        p.static_friction, p.delay, p.armature, p.damping, p.friction, p.delay
    )
}

fn data(p: &Parameters) -> Result<MjData<Box<MjModel>>> {
    let model = Box::new(
        MjModel::from_xml_string(&xml(p)).map_err(|e| anyhow::anyhow!("MuJoCo model: {e}"))?,
    );
    MjData::try_new(model).map_err(|e| anyhow::anyhow!("MuJoCo data: {e}"))
}

fn advance(
    d: &mut MjData<Box<MjModel>>,
    end: f64,
    commands: &[Command],
    p: &Parameters,
    index: &mut usize,
    torque: &mut f64,
) {
    while d.time() < end - 1e-10 {
        while *index < commands.len() && commands[*index].t + p.delay <= d.time() + 1e-10 {
            *torque = commands[*index].torque;
            *index += 1;
        }
        let mut boundary = end.min(d.time() + TIMESTEP);
        if *index < commands.len() {
            boundary = boundary.min(commands[*index].t + p.delay);
        }
        let h = boundary - d.time();
        if h <= 1e-10 {
            continue;
        }
        d.model_opt_mut().timestep = h;
        let friction = friction_at_speed(p, d.qvel()[0]);
        // Owned model; change only the runtime friction bound, not topology,
        // dimensions or cached inertia. No other data shares this model.
        unsafe { d.model_mut() }.dof_frictionloss_mut()[0] = friction;
        d.ctrl_mut()[0] = *torque;
        d.step();
    }
}

pub fn replay(trace: &Trace, p: &Parameters, cancel: &AtomicBool) -> Result<Vec<[f64; 2]>> {
    ensure!(!trace.samples.is_empty(), "Empty trace");
    let mut d = data(p)?;
    let initial = &trace.samples[0];
    d.qpos_mut()[0] = initial.position;
    d.qvel_mut()[0] = initial.velocity;
    d.set_time(initial.t);
    d.forward();
    let mut index = trace
        .commands
        .partition_point(|c| c.t + p.delay <= initial.t);
    let mut torque = if index == 0 {
        0.
    } else {
        trace.commands[index - 1].torque
    };
    let mut result = vec![[initial.position, initial.velocity]];
    for s in &trace.samples[1..] {
        ensure!(!cancel.load(Ordering::Relaxed), "Replay cancelled");
        advance(&mut d, s.t, &trace.commands, p, &mut index, &mut torque);
        ensure!(
            d.qpos()[0].is_finite() && d.qvel()[0].is_finite(),
            "Nonfinite simulation state"
        );
        result.push([d.qpos()[0], d.qvel()[0]]);
    }
    Ok(result)
}

#[cfg(test)]
pub fn demo_trace(
    c: &Config,
    truth: &Parameters,
    validation: bool,
    cancel: &AtomicBool,
) -> Result<Trace> {
    let mut d = data(truth)?;
    let dt = 1. / c.sample_hz;
    let duration = if validation {
        c.validation_seconds
    } else {
        c.train_seconds
    };
    let mut trace = Trace {
        name: if validation { "validation" } else { "training" }.into(),
        commands: vec![],
        samples: vec![],
    };
    let mut index = 0;
    let mut torque = 0.;
    let mut exciter = crate::experiment::Exciter::new(c, validation);
    // Deterministic synthetic sensor noise; no external random runtime needed.
    let noise = |i: usize| {
        ((i as f64 * 12.9898 + if validation { 8. } else { 3. }).sin() * 43758.5453).fract()
    };
    for i in 0..=(duration / dt) as usize {
        ensure!(!cancel.load(Ordering::Relaxed), "Demo cancelled");
        let t = i as f64 * dt;
        trace.samples.push(Sample {
            t,
            position: d.qpos()[0] + 0.00015 * noise(i),
            velocity: d.qvel()[0] + 0.004 * noise(i + 51),
            reported_torque: torque,
            temperature: 28.,
        });
        if i == (duration / dt) as usize {
            break;
        }
        let u = exciter.command(t, d.qpos()[0], d.qvel()[0], c, validation);
        let actual = protocol::torque(c.motor_id, u, &c.profile).1;
        trace.commands.push(Command { t, torque: actual });
        advance(
            &mut d,
            t + dt,
            &trace.commands,
            truth,
            &mut index,
            &mut torque,
        );
    }
    Ok(trace)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn constant() -> Trace {
        Trace {
            name: "test".into(),
            commands: vec![Command { t: 0., torque: 0.1 }],
            samples: [0., 0.1]
                .iter()
                .map(|&t| Sample {
                    t,
                    position: 0.,
                    velocity: 0.,
                    reported_torque: 0.,
                    temperature: 25.,
                })
                .collect(),
        }
    }
    #[test]
    fn armature_changes_actual_mujoco_acceleration() {
        let cancel = AtomicBool::new(false);
        let mut p = Parameters {
            armature: 0.01,
            damping: 0.,
            friction: 0.,
            delay: 0.,
            static_friction: 0.,
        };
        let a = replay(&constant(), &p, &cancel).unwrap();
        p.armature = 0.02;
        let b = replay(&constant(), &p, &cancel).unwrap();
        assert!((a[1][1] - 1.).abs() < 1e-6);
        assert!((b[1][1] - 0.5).abs() < 1e-6);
    }
    #[test]
    fn delay_uses_seconds_and_fractional_step_boundaries() {
        let p = Parameters {
            armature: 0.01,
            damping: 0.,
            friction: 0.,
            delay: 0.0235,
            static_friction: 0.,
        };
        let r = replay(&constant(), &p, &AtomicBool::new(false)).unwrap();
        assert!((r[1][1] - 0.765).abs() < 1e-6);
    }
    #[test]
    fn command_clock_is_independent_from_feedback_clock() {
        let mut tr = constant();
        tr.commands = vec![
            Command {
                t: 0.03,
                torque: 0.1,
            },
            Command {
                t: 0.06,
                torque: -0.1,
            },
        ];
        let p = Parameters {
            armature: 0.01,
            damping: 0.,
            friction: 0.,
            delay: 0.01,
            static_friction: 0.,
        };
        assert!(replay(&tr, &p, &AtomicBool::new(false)).unwrap()[1][1].abs() < 1e-8);
    }
    #[test]
    fn static_peak_holds_below_breakaway_and_releases_above_it() {
        let p = Parameters {
            armature: 0.01,
            damping: 0.,
            friction: 0.02,
            static_friction: 0.12,
            delay: 0.,
        };
        let cancel = AtomicBool::new(false);
        let mut trace = constant();
        let held = replay(&trace, &p, &cancel).unwrap();
        assert!(held[1][1].abs() < 0.02, "held velocity {}", held[1][1]);
        trace.commands[0].torque = 0.2;
        let moving = replay(&trace, &p, &cancel).unwrap();
        assert!(moving[1][1] > 1.);
        assert!((friction_at_speed(&p, 1.) - 0.02).abs() < 1e-8);
    }
    #[test]
    fn cancellation_stops_replay() {
        assert!(replay(&constant(), &Parameters::default(), &AtomicBool::new(true)).is_err());
    }
}
