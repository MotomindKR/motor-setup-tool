//! Documented CAN setup parameters and read-only telemetry.
//! Type 18 changes RAM; type 22 asks the motor to save persistent parameters.
use crate::{
    hardware::{Bus, StopGuard},
    protocol,
    types::Config,
};
use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use std::{thread, time::Duration};

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ValueType {
    Float32,
    Uint8,
}

#[derive(Clone, Deserialize, Serialize)]
pub struct Choice {
    pub value: u8,
    pub label: String,
}

#[derive(Clone, Deserialize, Serialize)]
pub struct Register {
    #[serde(deserialize_with = "deserialize_index")]
    pub index: u16,
    pub name: String,
    pub symbol: String,
    pub value_type: ValueType,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub choices: Vec<Choice>,
    pub readable: bool,
    pub writable: bool,
    pub editable: bool,
    pub persistence: Persistence,
    pub min: Option<f64>,
    pub max: Option<f64>,
    pub host_index: Option<String>,
    pub protected_reason: Option<String>,
    #[serde(default = "documented")]
    pub availability: String,
    #[serde(default, skip_serializing)]
    overrides: std::collections::BTreeMap<String, RegisterOverride>,
}

fn documented() -> String {
    "documented".into()
}

#[derive(Clone, Default, Deserialize)]
struct RegisterOverride {
    readable: Option<bool>,
    writable: Option<bool>,
    editable: Option<bool>,
    persistence: Option<Persistence>,
    availability: Option<String>,
    protected_reason: Option<String>,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Persistence {
    SaveToFlash,
    Volatile,
    Undocumented,
}

// CAN aliases, device permissions, editor policy and persistence share one catalog
// with Electron. Host-tool function codes are metadata, never wire addresses.
pub static CATALOG: std::sync::LazyLock<Vec<Register>> = std::sync::LazyLock::new(|| {
    serde_json::from_str(include_str!("../electron/register-catalog.json"))
        .expect("valid built-in CAN register catalog")
});

pub fn catalog(model: &str) -> Result<Vec<Register>> {
    ensure!(
        crate::types::Profile::preset(model).is_some(),
        "Unknown motor model"
    );
    Ok(CATALOG.iter().map(|item| item.for_model(model)).collect())
}

fn deserialize_index<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> std::result::Result<u16, D::Error> {
    let value = String::deserialize(deserializer)?;
    u16::from_str_radix(value.trim_start_matches("0x"), 16).map_err(serde::de::Error::custom)
}

impl Register {
    fn for_model(&self, model: &str) -> Self {
        let mut item = self.clone();
        if let Some(change) = self.overrides.get(model) {
            item.readable = change.readable.unwrap_or(item.readable);
            item.writable = change.writable.unwrap_or(item.writable);
            item.editable = change.editable.unwrap_or(item.editable);
            item.persistence = change.persistence.unwrap_or(item.persistence);
            if let Some(value) = &change.availability {
                item.availability = value.clone();
            }
            if let Some(value) = &change.protected_reason {
                item.protected_reason = Some(value.clone());
            }
        }
        item.editable &=
            item.readable && item.writable && item.persistence == Persistence::SaveToFlash;
        item
    }
    fn width(&self) -> usize {
        match self.value_type {
            ValueType::Float32 => 4,
            ValueType::Uint8 => 1,
        }
    }

    fn matches(&self, a: [u8; 4], b: [u8; 4]) -> bool {
        a[..self.width()] == b[..self.width()]
    }

    fn decode(&self, raw: [u8; 4]) -> Result<f64> {
        let value = match self.value_type {
            ValueType::Float32 => f64::from(f32::from_le_bytes(raw)),
            ValueType::Uint8 => f64::from(raw[0]),
        };
        ensure!(
            value.is_finite(),
            "Register 0x{:04X} returned a nonfinite value",
            self.index
        );
        Ok(value)
    }

    fn encode(&self, value: f64) -> Result<[u8; 4]> {
        let (min, max) = self
            .min
            .zip(self.max)
            .context("No documented writable range")?;
        ensure!(
            value.is_finite() && (min..=max).contains(&value),
            "{} must be between {} and {}",
            self.symbol,
            min,
            max
        );
        match self.value_type {
            ValueType::Float32 => Ok((value as f32).to_le_bytes()),
            ValueType::Uint8 => {
                ensure!(value.fract() == 0., "{} must be an integer", self.symbol);
                ensure!(
                    self.choices.is_empty()
                        || self
                            .choices
                            .iter()
                            .any(|choice| f64::from(choice.value) == value),
                    "{} is not a documented choice",
                    self.symbol
                );
                Ok([value as u8, 0, 0, 0])
            }
        }
    }
}

#[derive(Serialize)]
pub struct Reading {
    pub index: u16,
    pub value: f64,
    pub raw: String,
    pub uuid: String,
    pub save_acknowledged: bool,
}

fn register(index: u16) -> Result<&'static Register> {
    CATALOG
        .iter()
        .find(|item| item.index == index)
        .with_context(|| format!("Register 0x{index:04X} is not in the documented setup catalog"))
}

fn reading(index: u16, raw: [u8; 4], uuid: [u8; 8], save_acknowledged: bool) -> Result<Reading> {
    let value = register(index)?.decode(raw)?;
    Ok(Reading {
        index,
        value,
        raw: format!("{:08X}", u32::from_be_bytes(raw)),
        uuid: format!("{:016X}", u64::from_be_bytes(uuid)),
        save_acknowledged,
    })
}

pub fn read(c: &Config, index: u16) -> Result<Reading> {
    ensure!(
        register(index)?.for_model(&c.profile.model).readable,
        "Register 0x{index:04X} is not documented as readable for {}",
        c.profile.model
    );
    let bus = Bus::open(c)?;
    let _guard = StopGuard(&bus);
    bus.stopped()?;
    let uuid = bus.ping(c.motor_id, Duration::from_millis(200))?;
    reading(index, bus.read_parameter(index)?, uuid, false)
}

pub fn write(
    c: &Config,
    index: u16,
    value: f64,
    uuid: &str,
    expected_raw: &str,
) -> Result<Reading> {
    let item = register(index)?.for_model(&c.profile.model);
    ensure!(
        item.writable && item.editable && item.persistence == Persistence::SaveToFlash,
        "Register 0x{index:04X} is protected or read-only in this editor"
    );
    let desired = item.encode(value)?;
    let expected_uuid = protocol::parse_hex::<8>(uuid, "Motor UUID")?;
    let expected = protocol::parse_hex::<4>(expected_raw, "Previous register value")?;
    ensure!(
        !item.matches(desired, expected),
        "Value is unchanged; no save was sent"
    );

    let bus = Bus::open(c)?;
    let _guard = StopGuard(&bus);
    bus.stopped()?;
    let actual_uuid = bus.ping(c.motor_id, Duration::from_millis(200))?;
    ensure!(
        actual_uuid == expected_uuid,
        "Motor identity changed; read the register again"
    );
    ensure!(
        item.matches(bus.read_parameter(index)?, expected),
        "Register changed since it was read; read it again before saving"
    );
    bus.write_parameter_sized(index, desired, item.width())?;

    bus.flush()?;
    let mut save = protocol::frame(22, c.host_id as u16, c.motor_id);
    save.data = [1, 2, 3, 4, 5, 6, 7, 8];
    bus.send(save)?;
    let ack = bus.feedback(Duration::from_secs(2))?;
    ensure!(
        ack.mode == 0 && ack.faults == 0,
        "Motor did not acknowledge saving in stopped mode"
    );
    thread::sleep(Duration::from_millis(50));
    bus.stopped()?;
    let observed = bus.read_parameter(index)?;
    ensure!(
        item.matches(observed, desired),
        "Register changed after save; read it before retrying"
    );
    reading(index, observed, actual_uuid, true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zero_state_is_a_single_byte_enum_and_ignores_padding() {
        let item = register(0x7029).unwrap();
        assert_eq!(item.encode(1.).unwrap(), [1, 0, 0, 0]);
        assert_eq!(item.decode([1, 0xAB, 0xCD, 0xEF]).unwrap(), 1.);
        assert!(item.matches([1, 0, 0, 0], [1, 0xAB, 0xCD, 0xEF]));
        assert!(!item.matches([0, 0, 0, 0], [1, 0, 0, 0]));
        for value in [-1., 0.5, 2., 256., f64::NAN, f64::INFINITY] {
            assert!(item.encode(value).is_err());
        }
    }

    #[test]
    fn floats_use_wire_precision_and_reject_invalid_values() {
        let item = register(0x702B).unwrap();
        let raw = item.encode(-1.25).unwrap();
        assert_eq!(raw, (-1.25_f32).to_le_bytes());
        assert_eq!(item.decode(raw).unwrap(), -1.25);
        assert!(item.matches(item.encode(0.1).unwrap(), 0.1_f32.to_le_bytes()));
        assert!(item.encode(-7.01).is_err());
        assert!(item.encode(f64::NAN).is_err());
        assert!(item.decode(f32::NAN.to_le_bytes()).is_err());
        assert!(register(0x7014).unwrap().encode(1.01).is_err());
    }

    #[test]
    fn host_aliases_are_metadata_and_unreadable_overrides_block_editing() {
        for host in CATALOG.iter().filter_map(|item| item.host_index.as_ref()) {
            let index = u16::from_str_radix(host.trim_start_matches("0x"), 16).unwrap();
            assert!(register(index).is_err());
        }
        let mut reg = register(0x7010).unwrap().clone();
        reg.overrides.insert(
            "test-model".into(),
            RegisterOverride {
                readable: Some(false),
                ..Default::default()
            },
        );
        let overridden = reg.for_model("test-model");
        assert!(!overridden.readable && !overridden.editable);
        assert!(reg.for_model("other-model").editable);
    }

    #[test]
    fn previous_values_require_exact_hex_length_and_ascii() {
        assert!(protocol::parse_hex::<4>("0000803F", "value").is_ok());
        assert!(protocol::parse_hex::<4>("0000803", "value").is_err());
        assert!(protocol::parse_hex::<4>("é000000", "value").is_err());
        assert!(protocol::parse_hex::<8>("0000803F", "uuid").is_err());
    }
}
