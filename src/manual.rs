//! Exclusive, bounded manual control. The renderer renews a time-limited motion intent.
use crate::{
    encoder::EncoderTracker,
    hardware::{Bus, StopGuard},
    protocol::{self, Feedback},
    types::Config,
};
use anyhow::{Result, ensure};
use std::{
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

const UI_DEADLINE: Duration = Duration::from_millis(250);

#[derive(Clone)]
pub struct Intent {
    pub enabled: bool,
    pub direction: i8,
    pub speed: f64,
    pub heartbeat: Instant,
}
impl Intent {
    fn fresh(&self, now: Instant) -> bool {
        now.saturating_duration_since(self.heartbeat) < UI_DEADLINE
    }
}

#[derive(Clone, Default)]
pub struct Status {
    pub feedback: Option<Feedback>,
    pub received: Option<Instant>,
    pub enabled: bool,
    pub preparing: bool,
    pub error: Option<String>,
    pub stop_reason: Option<String>,
}

pub struct Session {
    pub intent: Arc<Mutex<Intent>>,
    pub status: Arc<Mutex<Status>>,
    cancel: Arc<AtomicBool>,
    job: Option<JoinHandle<()>>,
}
impl Session {
    pub fn start(config: Config, uuid: [u8; 8]) -> Self {
        let intent = Arc::new(Mutex::new(Intent {
            enabled: false,
            direction: 0,
            speed: max_speed(&config).min(0.5),
            heartbeat: Instant::now(),
        }));
        let status = Arc::new(Mutex::new(Status::default()));
        let cancel = Arc::new(AtomicBool::new(false));
        let (input, output, stop) = (intent.clone(), status.clone(), cancel.clone());
        let job = thread::spawn(move || {
            let result = run(&config, uuid, &input, &output, &stop);
            let mut state = output.lock().unwrap();
            state.enabled = false;
            state.preparing = false;
            if let Err(error) = result {
                state.error = Some(format!("{error:#}"));
            }
        });
        Self {
            intent,
            status,
            cancel,
            job: Some(job),
        }
    }
    pub fn snapshot(&self) -> Status {
        self.status.lock().unwrap().clone()
    }
    pub fn finished(&self) -> bool {
        self.job.as_ref().is_none_or(|j| j.is_finished())
    }
}
impl Drop for Session {
    fn drop(&mut self) {
        self.cancel.store(true, Ordering::Relaxed);
        if let Some(job) = self.job.take() {
            let _ = job.join();
        }
    }
}

pub fn max_speed(c: &Config) -> f64 {
    (c.speed_limit * 0.1).min(1.)
}
pub fn torque_limit(c: &Config) -> f64 {
    c.profile
        .spec()
        .map_or(0., |s| c.torque_limit.min(s.rated_torque * 0.1))
}
fn motion_requested(input: &Intent, now: Instant) -> bool {
    input.enabled && input.fresh(now)
}

fn jog_target(c: &Config, requested: f64, position: f64) -> f64 {
    if requested == 0. {
        return 0.;
    }
    let remaining = c.travel_limit - position * requested.signum();
    let margin = (max_speed(c) * 0.1).min(c.travel_limit * 0.1);
    let braking_distance = max_speed(c).min(c.travel_limit * 0.5);
    requested * ((remaining - margin) / (braking_distance - margin)).clamp(0., 1.)
}

fn jog_torque(c: &Config, target: f64, velocity: f64, dt: f64, integral: &mut f64) -> f64 {
    let error = target - velocity;
    // Clear accumulated drive on release; oppose motion without holding position.
    *integral = if target == 0. {
        0.
    } else {
        (*integral + error * dt).clamp(-0.5, 0.5)
    };
    let limit = torque_limit(c);
    (limit * (error / max_speed(c) + *integral)).clamp(-limit, limit)
}

fn validate_feedback(c: &Config, fb: &Feedback, position: f64) -> Result<()> {
    ensure!(
        fb.faults == 0,
        "Motor fault 0x{:02x}; disable and inspect the motor",
        fb.faults
    );
    ensure!(
        fb.temperature < c.temperature_limit,
        "Temperature {:.1} °C reached the {:.1} °C limit; let the motor cool",
        fb.temperature,
        c.temperature_limit
    );
    ensure!(
        fb.velocity.abs() < c.speed_limit.min(max_speed(c) * 2. + 0.5),
        "Jog speed {:.3} rad/s reached the {:.3} rad/s limit",
        fb.velocity,
        c.speed_limit.min(max_speed(c) * 2. + 0.5)
    );
    ensure!(
        position.abs() < c.travel_limit,
        "Jog moved {:.3} rad from enable (limit ±{:.3} rad); motor disabled",
        position,
        c.travel_limit
    );
    Ok(())
}

fn run(
    c: &Config,
    uuid: [u8; 8],
    input: &Mutex<Intent>,
    output: &Mutex<Status>,
    cancel: &AtomicBool,
) -> Result<()> {
    c.validate()?;
    let bus = Bus::open(c)?;
    let _guard = StopGuard(&bus);
    ensure!(
        bus.ping(c.motor_id, Duration::from_millis(100))? == uuid,
        "Motor identity changed; scan again"
    );
    ensure!(
        protocol::firmware_model(&bus.firmware_version()?).as_deref() == Some(&c.profile.model),
        "Motor model changed; scan again"
    );
    let mut fb = bus.stopped()?;
    let mut enabled = false;
    let mut has_jogged = false;
    let mut encoder = EncoderTracker::new(fb.position, c.profile.position_range, c.speed_limit);
    let mut encoder_start = Instant::now();
    let mut position = 0.;
    let mut integral = 0.;
    let mut stop_reason = None;
    let mut last_tick = Instant::now();
    while !cancel.load(Ordering::Relaxed) {
        let now = Instant::now();
        let dt = now.duration_since(last_tick).as_secs_f64();
        last_tick = now;
        let request = input.lock().unwrap().clone();
        if !request.fresh(now) {
            // Latch off: resuming rendering cannot re-enable a stalled UI.
            input.lock().unwrap().enabled = false;
        }
        let wanted = motion_requested(&request, now);
        if wanted && !enabled {
            validate_feedback(c, &fb, 0.)?;
            output.lock().unwrap().preparing = true;
            bus.stopped()?;
            // Recheck on every enable: a power cycle while disabled can reset
            // the motor's volatile watchdog and operation-mode registers.
            let preflight = bus.watchdog_preflight(cancel, |enabled| {
                output.lock().unwrap().enabled = enabled;
            })?;
            let expired = preflight.feedback;
            ensure!(
                expired.mode == 0 && expired.faults == 0,
                "Firmware watchdog did not stop the motor; check firmware watchdog support and other CAN senders before jogging"
            );
            // Re-check intent after the blocking handshake and quiet interval.
            let latest = input.lock().unwrap().clone();
            if cancel.load(Ordering::Relaxed) {
                break;
            }
            if !latest.enabled || !latest.fresh(Instant::now()) {
                input.lock().unwrap().enabled = false;
                output.lock().unwrap().preparing = false;
                continue;
            }
            fb = bus.enable_zero_torque(cancel)?;
            encoder = EncoderTracker::new(fb.position, c.profile.position_range, c.speed_limit);
            encoder_start = Instant::now();
            position = 0.;
            integral = 0.;
            has_jogged = false;
            enabled = true;
            stop_reason = None;
            output.lock().unwrap().preparing = false;
            last_tick = Instant::now();
            continue;
        } else if !wanted && enabled {
            stop_reason = Some(
                if !request.fresh(now) {
                    "UI updates paused · motor disabled"
                } else {
                    "Motor disabled"
                }
                .into(),
            );
            bus.stop()?;
            enabled = false;
            input.lock().unwrap().enabled = false;
            integral = 0.;
        }
        bus.flush()?;
        if enabled {
            ensure!(dt < 0.1, "Jog control missed its deadline; motor disabled");
            let direction = request.direction.clamp(-1, 1) as f64;
            ensure!(request.speed.is_finite(), "Invalid jog speed");
            let requested = direction * request.speed.clamp(0., max_speed(c));
            let target = jog_target(c, requested, position);
            if target != requested {
                // Do not carry accumulated drive into the travel braking zone.
                integral = 0.;
            }
            if direction != 0. {
                has_jogged = true;
                stop_reason = if target == 0. {
                    Some("Travel limit reached · jog back to continue".into())
                } else {
                    None
                };
            }
            // Enabling alone applies zero torque. After a jog, releasing holds
            // zero speed with bounded braking torque, without a position hold.
            let torque = if has_jogged {
                jog_torque(c, target, fb.velocity, dt, &mut integral)
            } else {
                0.
            };
            bus.send(protocol::torque(c.motor_id, torque, &c.profile).0)?;
        } else {
            // Type-4 stop requests return feedback without enabling or clearing faults.
            bus.stop()?;
        }
        fb = bus.feedback(Duration::from_millis(50))?;
        if enabled {
            ensure!(
                fb.mode == 2,
                "Motor left Run mode; enable again after checking its status"
            );
            position = encoder.update(fb.position, encoder_start.elapsed())?;
            validate_feedback(c, &fb, position)?;
        } else {
            ensure!(
                fb.mode == 0,
                "Motor did not acknowledge disabled mode; monitoring stopped"
            );
        }
        *output.lock().unwrap() = Status {
            feedback: Some(fb.clone()),
            received: Some(Instant::now()),
            enabled,
            preparing: false,
            error: None,
            stop_reason: stop_reason.clone(),
        };
        thread::sleep(if enabled {
            Duration::from_millis(5)
        } else {
            Duration::from_millis(40)
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn release_keeps_enabled_but_stale_ui_removes_authority() {
        let now = Instant::now();
        let mut request = Intent {
            enabled: true,
            direction: 1,
            speed: 0.5,
            heartbeat: now,
        };
        assert!(motion_requested(&request, now));
        assert!(!motion_requested(&request, now + UI_DEADLINE));
        request.direction = 0;
        assert!(motion_requested(&request, now));
        request.enabled = false;
        request.direction = -1;
        assert!(!motion_requested(&request, now));
    }
    #[test]
    fn release_brakes_in_both_directions_without_residual_drive() {
        for profile in crate::types::Profile::presets() {
            let c = Config::preset(&profile.model).unwrap();
            for velocity in [-0.5_f64, 0.5] {
                let mut integral = velocity.signum() * 0.5;
                let torque = jog_torque(&c, 0., velocity, 0.005, &mut integral);
                assert!(torque * velocity < 0.);
                assert!(torque.abs() <= torque_limit(&c));
                assert_eq!(integral, 0.);
            }
            assert_eq!(jog_torque(&c, 0., 0., 0.005, &mut 0.5), 0.);
        }
    }
    #[test]
    fn every_model_has_bounded_jog_limits_and_faults_stop_motion() {
        for profile in crate::types::Profile::presets() {
            let c = Config::preset(&profile.model).unwrap();
            assert!(max_speed(&c) > 0. && max_speed(&c) <= 1.);
            assert!(torque_limit(&c) > 0. && torque_limit(&c) <= c.torque_limit);
            let mut fb = Feedback {
                position: 0.,
                velocity: 0.,
                torque: 0.,
                temperature: 25.,
                faults: 0,
                mode: 2,
            };
            assert!(validate_feedback(&c, &fb, 0.).is_ok());
            assert!(validate_feedback(&c, &fb, c.travel_limit).is_err());
            fb.faults = 1;
            assert!(validate_feedback(&c, &fb, 0.).is_err());
            fb.faults = 0;
            fb.temperature = c.temperature_limit;
            assert!(validate_feedback(&c, &fb, 0.).is_err());
            fb.temperature = 25.;
            fb.velocity = c.speed_limit;
            assert!(validate_feedback(&c, &fb, 0.).is_err());
        }
    }
    #[test]
    fn jogging_passes_one_revolution_and_uses_the_configured_travel_limit() {
        let mut c = Config::default();
        let fb = Feedback {
            position: 0.,
            velocity: 0.5,
            torque: 0.,
            temperature: 25.,
            faults: 0,
            mode: 2,
        };
        for sign in [-1., 1.] {
            assert!(validate_feedback(&c, &fb, sign * 6.288).is_ok());
            assert_eq!(jog_target(&c, sign * 0.5, sign * 6.288), sign * 0.5);
        }
        c.travel_limit = 2.;
        assert!(validate_feedback(&c, &fb, 2.).is_err());
    }

    #[test]
    fn travel_boundary_slows_outward_jogging_and_allows_reverse() {
        let c = Config::default();
        for sign in [-1., 1.] {
            let requested = sign * 0.5;
            let approaching = sign * (c.travel_limit - 0.5);
            let near = sign * (c.travel_limit - 0.01);
            let slowed = jog_target(&c, requested, approaching);
            assert!(slowed * sign > 0. && slowed.abs() < requested.abs());
            assert_eq!(jog_target(&c, requested, near), 0.);
            assert_eq!(jog_target(&c, -requested, near), -requested);
            assert_eq!(jog_target(&c, 0., near), 0.);
        }
    }

    #[test]
    fn held_jog_brakes_before_the_cutoff_and_can_reverse_in_simulation() {
        use mujoco_rs::prelude::{MjData, MjModel};
        let c = Config {
            travel_limit: 0.5,
            ..Config::default()
        };
        for sign in [-1., 1.] {
            let model =
                Box::new(MjModel::from_xml_string(&crate::engine::xml(&c.baseline)).unwrap());
            let mut data = MjData::try_new(model).unwrap();
            data.model_opt_mut().timestep = 0.005;
            let mut integral = 0.;
            for tick in 0..1600 {
                let requested = if tick < 1000 { sign * 0.5 } else { -sign * 0.5 };
                let target = jog_target(&c, requested, data.qpos()[0]);
                if target != requested {
                    integral = 0.;
                }
                data.ctrl_mut()[0] = jog_torque(&c, target, data.qvel()[0], 0.005, &mut integral);
                data.step();
                assert!(
                    data.qpos()[0].abs() < c.travel_limit,
                    "jog crossed its cutoff"
                );
                if tick == 999 {
                    assert!(data.qpos()[0] * sign > 0.35);
                    assert!(data.qvel()[0].abs() < 0.02);
                }
            }
            assert!(
                data.qpos()[0] * sign < 0.,
                "reverse jog did not leave the boundary"
            );
        }
    }
}
