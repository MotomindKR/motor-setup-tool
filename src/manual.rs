//! Exclusive, bounded manual control. The UI must renew its intent every frame.
use crate::{
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
pub fn travel_limit(c: &Config) -> f64 {
    c.travel_limit.min(std::f64::consts::TAU)
}

fn motion_requested(input: &Intent, now: Instant, was_jogging: bool) -> bool {
    input.enabled && input.fresh(now) && !(was_jogging && input.direction == 0)
}

fn validate_feedback(c: &Config, fb: &Feedback, position: f64) -> Result<()> {
    ensure!(
        fb.faults == 0,
        "Motor fault 0x{:02x}; disable and inspect the motor",
        fb.faults
    );
    ensure!(
        fb.temperature < c.temperature_limit,
        "Temperature limit reached; let the motor cool"
    );
    ensure!(
        fb.velocity.abs() < c.speed_limit.min(max_speed(c) * 2. + 0.5),
        "Jog speed limit reached"
    );
    ensure!(
        position.abs() < travel_limit(c),
        "Jog travel limit reached; motor disabled"
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
    let mut watchdog_verified = false;
    let mut was_jogging = false;
    let mut position = 0.;
    let mut previous = fb.position;
    let mut integral = 0.;
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
        let wanted = motion_requested(&request, now, was_jogging);
        if wanted && !enabled {
            validate_feedback(c, &fb, 0.)?;
            output.lock().unwrap().preparing = true;
            bus.stopped()?;
            if !watchdog_verified {
                let expired = bus.watchdog_preflight(cancel)?;
                ensure!(
                    expired.mode == 0 && expired.faults == 0,
                    "Firmware watchdog did not stop the motor; update firmware before jogging"
                );
                watchdog_verified = true;
            }
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
            previous = fb.position;
            position = 0.;
            integral = 0.;
            enabled = true;
            output.lock().unwrap().preparing = false;
            last_tick = Instant::now();
        } else if !wanted && enabled {
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
            let target = direction * request.speed.clamp(0., max_speed(c));
            // Bounded velocity PI over the same torque-only protocol as calibration.
            // No position hold; released buttons disable the motor.
            let limit = torque_limit(c);
            let error = target - fb.velocity;
            integral = if direction == 0. {
                0.
            } else {
                (integral + error * dt).clamp(-0.5, 0.5)
            };
            let torque = if direction == 0. {
                0.
            } else {
                (limit * (error / max_speed(c) + integral)).clamp(-limit, limit)
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
            let mut delta = fb.position - previous;
            let span = c.profile.position_range * 2.;
            if delta > span / 2. {
                delta -= span;
            }
            if delta < -span / 2. {
                delta += span;
            }
            ensure!(
                delta.abs() < c.speed_limit * dt.max(0.01) + 0.02,
                "Implausible encoder jump; motor disabled"
            );
            position += delta;
            previous = fb.position;
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
        };
        was_jogging = enabled && request.direction != 0;
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
    fn release_and_stale_ui_remove_motion_authority() {
        let now = Instant::now();
        let mut request = Intent {
            enabled: true,
            direction: 1,
            speed: 0.5,
            heartbeat: now,
        };
        assert!(motion_requested(&request, now, false));
        assert!(!motion_requested(&request, now + UI_DEADLINE, false));
        request.direction = 0;
        assert!(!motion_requested(&request, now, true));
        request.enabled = false;
        request.direction = -1;
        assert!(!motion_requested(&request, now, false));
    }
    #[test]
    fn every_model_has_bounded_jog_limits_and_faults_stop_motion() {
        for profile in crate::types::Profile::presets() {
            let mut c = Config {
                profile,
                ..Default::default()
            };
            c.apply_spec_limits();
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
            assert!(validate_feedback(&c, &fb, travel_limit(&c)).is_err());
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
}
