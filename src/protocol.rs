use crate::types::Profile;

#[derive(Clone, Debug)]
pub struct WireFrame {
    pub id: u32,
    pub data: [u8; 8],
}
#[derive(Clone, Debug)]
pub struct Feedback {
    pub position: f64,
    pub velocity: f64,
    pub torque: f64,
    pub temperature: f64,
    pub faults: u8,
    pub mode: u8,
}
pub fn frame(kind: u8, field: u16, target: u8) -> WireFrame {
    WireFrame {
        id: ((kind as u32) << 24) | ((field as u32) << 8) | target as u32,
        data: [0; 8],
    }
}
fn encode(x: f64, range: f64) -> u16 {
    (((x.clamp(-range, range) + range) / (2. * range) * 65535.).round()) as u16
}
fn decode(x: u16, range: f64) -> f64 {
    x as f64 / 65535. * 2. * range - range
}
pub fn torque(id: u8, value: f64, p: &Profile) -> (WireFrame, f64) {
    let encoded = encode(value, p.torque_range);
    let mut f = frame(1, encoded, id);
    f.data[0..2].copy_from_slice(&encode(0., p.position_range).to_be_bytes());
    f.data[2..4].copy_from_slice(&encode(0., p.velocity_range).to_be_bytes());
    // Kp and Kd are exactly zero, encoded with an unsigned range starting at 0.
    (f, decode(encoded, p.torque_range))
}
pub fn write_u8(host: u8, motor: u8, index: u16, value: u8) -> WireFrame {
    let mut f = frame(18, host as u16, motor);
    f.data[..2].copy_from_slice(&index.to_le_bytes());
    f.data[4] = value;
    f
}
pub fn version_request(host: u8, motor: u8) -> WireFrame {
    let mut f = frame(4, host as u16, motor);
    f.data[1] = 0xc4;
    f
}
/// Model families used by the official firmware release filenames (0.N.x.y).
/// Unknown version schemes are not guessed. This is firmware identity, not a
/// verification of the physical motor label or correct flashing.
pub fn firmware_model(version: &str) -> Option<String> {
    let v: Vec<u8> = version
        .split('.')
        .map(str::parse)
        .collect::<Result<_, _>>()
        .ok()?;
    if v.len() == 4 && v[0] == 0 && v[1] <= 6 {
        Some(format!("RS-{:02}", v[1]))
    } else {
        None
    }
}
pub fn firmware_version(f: &WireFrame, motor: u8, host: u8) -> Option<[u8; 4]> {
    if f.id >> 24 == 2
        && (f.id >> 8) as u8 == motor
        && f.id as u8 == host
        && f.data[..3] == [0, 0xc4, 0x56]
    {
        Some(f.data[3..7].try_into().unwrap())
    } else {
        None
    }
}
pub fn fault_report(f: &WireFrame, motor: u8, host: u8) -> Option<(u32, u32)> {
    if f.id >> 24 == 21 && (f.id >> 8) as u8 == motor && f.id as u8 == host {
        Some((
            u32::from_le_bytes(f.data[..4].try_into().unwrap()),
            u32::from_le_bytes(f.data[4..].try_into().unwrap()),
        ))
    } else {
        None
    }
}
pub fn feedback(f: &WireFrame, motor: u8, host: u8, p: &Profile) -> Option<Feedback> {
    if (f.id >> 24) & 31 != 2 || (f.id >> 8) as u8 != motor || f.id as u8 != host {
        return None;
    }
    if firmware_version(f, motor, host).is_some() {
        return None;
    }
    let field = (f.id >> 8) as u16;
    let val = |offset: usize| u16::from_be_bytes([f.data[offset], f.data[offset + 1]]);
    Some(Feedback {
        position: decode(val(0), p.position_range),
        velocity: decode(val(2), p.velocity_range),
        torque: decode(val(4), p.torque_range),
        temperature: val(6) as f64 / 10.,
        faults: ((field >> 8) & 63) as u8,
        mode: ((field >> 14) & 3) as u8,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn documented_rs00_encoding_and_feedback_use_33_and_14() {
        let p = Profile::presets()[0].clone();
        let (command, _) = torque(7, 7., &p);
        assert_eq!(command.id, 0x01bfff07);
        let f = WireFrame {
            id: 0x028007fd,
            data: [0xff, 0xff, 0xff, 0xff, 0, 0, 1, 0x90],
        };
        let fb = feedback(&f, 7, 253, &p).unwrap();
        assert!((fb.position - 4. * std::f64::consts::PI).abs() < 1e-12);
        assert_eq!(
            (fb.velocity, fb.torque, fb.temperature, fb.mode),
            (33., -14., 40., 2)
        );
    }
    #[test]
    fn version_reply_is_not_motion_and_fault_reports_preserve_driver_bit() {
        let request = version_request(253, 7);
        assert_eq!(request.id, 0x0400fd07);
        assert_eq!(request.data, [0, 0xc4, 0, 0, 0, 0, 0, 0]);
        let f = WireFrame {
            id: 0x020007fd,
            data: [0, 0xc4, 0x56, 0, 0, 3, 32, 0],
        };
        assert_eq!(firmware_version(&f, 7, 253), Some([0, 0, 3, 32]));
        assert!(firmware_version(&f, 8, 253).is_none());
        assert!(firmware_version(&f, 7, 254).is_none());
        assert!(feedback(&f, 7, 253, &Profile::presets()[0]).is_none());
        let f = WireFrame {
            id: 0x150007fd,
            data: [2, 0x40, 1, 0, 1, 0, 0, 0],
        };
        assert_eq!(fault_report(&f, 7, 253), Some((0x14002, 1)));
        assert!(fault_report(&f, 8, 253).is_none());
    }
    #[test]
    fn torque_frame_has_zero_gains_and_reports_actual_wire_command() {
        for p in Profile::presets() {
            for x in [-0.25, 0., 0.25] {
                let (f, actual) = torque(7, x, &p);
                assert_eq!(f.id >> 24, 1);
                assert_eq!(f.id as u8, 7);
                assert_eq!(&f.data[4..], &[0, 0, 0, 0]);
                assert!((actual - x).abs() <= p.torque_range / 65535. + 1e-9);
            }
        }
    }
    #[test]
    fn feedback_checks_source_destination_and_faults() {
        let p = Profile::presets()[1].clone();
        let mut f = frame(2, (2 << 14) | (4 << 8) | 7, 253);
        f.data[6..].copy_from_slice(&421_u16.to_be_bytes());
        let result = feedback(&f, 7, 253, &p).unwrap();
        assert_eq!(result.mode, 2);
        assert_eq!(result.faults, 4);
        assert_eq!(result.temperature, 42.1);
        assert!(feedback(&f, 8, 253, &p).is_none());
        assert!(feedback(&f, 7, 254, &p).is_none());
    }
}
