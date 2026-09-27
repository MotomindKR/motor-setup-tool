//! Unwrap position while allowing bounded USB/host delivery jitter.
use anyhow::{Result, ensure};
use std::{collections::VecDeque, time::Duration};

const ARRIVAL_JITTER: Duration = Duration::from_millis(5);
const HISTORY: Duration = Duration::from_millis(50);
const POSITION_TOLERANCE: f64 = 0.02;

pub(crate) struct EncoderTracker {
    span: f64,
    speed_limit: f64,
    last_raw: f64,
    position: f64,
    history: VecDeque<(Duration, f64)>,
}

impl EncoderTracker {
    /// The initial feedback defines position zero and receive time zero.
    pub(crate) fn new(raw: f64, range: f64, speed_limit: f64) -> Self {
        Self {
            span: 2. * range,
            speed_limit,
            last_raw: raw,
            position: 0.,
            history: VecDeque::from([(Duration::ZERO, 0.)]),
        }
    }

    pub(crate) fn update(&mut self, raw: f64, received_at: Duration) -> Result<f64> {
        ensure!(raw.is_finite(), "Encoder feedback is not finite");
        ensure!(
            received_at >= self.history.back().expect("initial observation").0,
            "Feedback receive time moved backwards"
        );
        let delta = (raw - self.last_raw + self.span / 2.).rem_euclid(self.span) - self.span / 2.;
        let position = self.position + delta;
        // Arrival intervals are not motor sample intervals. A late USB packet
        // shortens the next interval even when shaft motion is continuous.
        // Check every recent anchor: the jitter allowance is shared across a
        // window, so repeated small jumps cannot each spend a fresh allowance.
        for &(time, previous) in &self.history {
            let dt = (received_at - time).as_secs_f64();
            let allowed =
                self.speed_limit * (dt + ARRIVAL_JITTER.as_secs_f64()) + POSITION_TOLERANCE;
            ensure!(
                (position - previous).abs() <= allowed,
                "Encoder feedback discontinuity: {:.4} rad over {:.3} ms exceeds {:.4} rad (includes 5 ms arrival jitter). Raw position {:.4} -> {:.4} rad. Motor stopped; check encoder/CAN feedback",
                position - previous,
                dt * 1000.,
                allowed,
                self.last_raw,
                raw
            );
        }
        // Keep one anchor just outside the window as well as the last sample.
        while self.history.len() > 1 && received_at - self.history[1].0 > HISTORY {
            self.history.pop_front();
        }
        self.history.push_back((received_at, position));
        self.last_raw = raw;
        self.position = position;
        Ok(position)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{Config, Profile};

    #[test]
    fn delayed_then_compressed_feedback_does_not_look_like_an_encoder_jump() {
        // RS-00 measured increments from recording 1790515762252-1281258,
        // retimed to an 8 ms / 2 ms pair. Aborted recordings end on a delayed
        // 7–9 ms interval; the rejected frame itself was not previously saved.
        let positions = [
            4.557142962094451,
            4.505753821564227,
            4.45398117998527,
            4.401825037357579,
        ];
        let arrivals = [0, 5, 13, 15];
        let limit = 14.844025288211773;
        let mut tracker = EncoderTracker::new(positions[0], 4. * std::f64::consts::PI, limit);
        assert!((positions[3] - positions[2]).abs() > limit * 0.002 + POSITION_TOLERANCE);
        for i in 1..positions.len() {
            let p = tracker
                .update(positions[i], Duration::from_millis(arrivals[i]))
                .unwrap();
            assert!((p - (positions[i] - positions[0])).abs() < 1e-12);
        }
    }

    #[test]
    fn all_models_unwrap_both_directions_with_batched_arrivals() {
        for profile in Profile::presets() {
            let mut config = Config {
                profile,
                ..Default::default()
            };
            config.apply_spec_limits();
            let range = config.profile.position_range;
            for direction in [-1., 1.] {
                let origin = direction * (range - 0.01);
                let velocity = direction * config.speed_limit * 0.75;
                let mut tracker = EncoderTracker::new(origin, range, config.speed_limit);
                for i in 1..=1000 {
                    let t = i as f64 * 0.005;
                    let raw = (origin + velocity * t + range).rem_euclid(2. * range) - range;
                    let delay = if i % 2 == 1 { 5 } else { 0 };
                    let p = tracker
                        .update(raw, Duration::from_millis(i * 5 + delay))
                        .unwrap();
                    assert!((p - velocity * t).abs() < 1e-9);
                }
                assert!(tracker.history.len() <= 13);
            }
        }
    }

    #[test]
    fn real_jumps_and_sustained_excess_motion_are_rejected() {
        let range = 4. * std::f64::consts::PI;
        let mut tracker = EncoderTracker::new(0., range, 14.844);
        let error = tracker.update(0.5, Duration::from_millis(5)).unwrap_err();
        assert!(error.to_string().contains("discontinuity"));
        // Rejection must not advance the position or timing reference.
        assert!(tracker.update(0.05, Duration::from_millis(5)).is_ok());
        assert!(tracker.update(f64::NAN, Duration::from_millis(10)).is_err());
        assert!(tracker.update(0.06, Duration::from_millis(4)).is_err());

        let mut tracker = EncoderTracker::new(0., range, 14.844);
        assert!(tracker.update(0.06, Duration::from_millis(1)).is_ok());
        assert!(tracker.update(0.12, Duration::from_millis(2)).is_ok());
        // Each 0.06 rad step fits a single-packet allowance, but the accumulated
        // displacement cannot fit the speed envelope over the entire window.
        assert!(tracker.update(0.18, Duration::from_millis(3)).is_err());
    }
}
