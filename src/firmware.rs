//! RobStride private-CAN firmware updates (types 11–14).
//! Protocol: RobStride/Product_Information/OTA (PDF + vendor OTA.py).
use crate::{bridge, hardware::Bus, protocol, types::Config};
use anyhow::{Context, Result, bail, ensure};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::Write,
    path::PathBuf,
    thread,
    time::{Duration, Instant},
};

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Release {
    pub model: String,
    pub version: String,
    pub filename: String,
    pub url: String,
    pub sha256: String,
}
pub fn release(model: &str) -> Result<Release> {
    let all: Vec<Release> = serde_json::from_str(include_str!("firmware_catalog.json"))?;
    all.into_iter()
        .find(|r| r.model == model)
        .context("No bundled official firmware for selected model")
}
/// Compare only known firmware families against the verified, bundled catalog.
/// Missing/malformed versions and newer installed versions are never upgrades.
pub fn available_update(model: &str, installed: &str) -> Option<Release> {
    if protocol::firmware_model(installed).as_deref() != Some(model) {
        return None;
    }
    let candidate = release(model).ok()?;
    if protocol::firmware_model(&candidate.version).as_deref() != Some(model) {
        return None;
    }
    (protocol::version_parts(installed)? < protocol::version_parts(&candidate.version)?)
        .then_some(candidate)
}
fn verify_image(bytes: &[u8], r: &Release) -> Result<()> {
    ensure!(
        !bytes.is_empty() && bytes.len() <= 0x80000,
        "Invalid firmware size"
    );
    ensure!(
        Sha256::digest(bytes)
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>()
            == r.sha256,
        "Firmware SHA-256 mismatch; download the official file again"
    );
    Ok(())
}
fn download_image(r: &Release) -> Result<Vec<u8>> {
    let agent = ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(60)))
        .build()
        .new_agent();
    let mut response = match agent.get(&r.url).call() {
        Ok(response) => response,
        Err(ureq::Error::StatusCode(404)) => bail!(
            "RobStride no longer hosts {} firmware {}. Check for an app update.",
            r.model,
            r.version
        ),
        Err(error) => {
            return Err(error)
                .with_context(|| format!("Could not download {} firmware {}", r.model, r.version));
        }
    };
    let bytes = response
        .body_mut()
        .with_config()
        .limit(0x80001)
        .read_to_vec()?;
    verify_image(&bytes, r)?;
    Ok(bytes)
}
#[derive(Clone, Debug)]
pub struct Prepared {
    pub release: Release,
    pub path: PathBuf,
    pub current_version: String,
    pub uuid: [u8; 8],
    pub interface: String,
    pub motor_id: u8,
    pub host_id: u8,
}
impl Prepared {
    pub fn matches(&self, c: &Config) -> bool {
        self.interface == c.interface
            && self.motor_id == c.motor_id
            && self.host_id == c.host_id
            && self.release.model == c.profile.model
    }
}
fn check_model(version: &str, model: &str) -> Result<()> {
    ensure!(
        protocol::firmware_model(version).as_deref() == Some(model),
        "Firmware {version} does not identify selected {model}; update blocked"
    );
    Ok(())
}
pub fn prepare(c: &Config, progress: impl Fn(String)) -> Result<Prepared> {
    let r = release(&c.profile.model)?;
    progress(format!(
        "Preparing official {} firmware {}",
        r.model, r.version
    ));
    let directory = crate::paths::cache_dir()?.join("firmware");
    fs::create_dir_all(&directory)?;
    let path = directory.join(&r.filename);
    if !fs::read(&path).is_ok_and(|bytes| verify_image(&bytes, &r).is_ok()) {
        let bytes = download_image(&r)?;
        fs::write(&path, bytes)?;
    }
    let bus = Bus::open(c)?;
    bus.stopped()?;
    let current_version = bus.firmware_version()?;
    check_model(&current_version, &r.model)?;
    let uuid = bus.ping(c.motor_id, Duration::from_millis(200))?;
    Ok(Prepared {
        release: r,
        path,
        current_version,
        uuid,
        interface: c.interface.clone(),
        motor_id: c.motor_id,
        host_id: c.host_id,
    })
}

fn ack_result(f: &protocol::WireFrame, kind: u8, motor: u8, host: u8) -> Option<(u8, [u8; 8])> {
    (f.id >> 24 == kind as u32 && (f.id >> 8) as u8 == motor && f.id as u8 == host)
        .then_some(((f.id >> 16) as u8, f.data))
}
fn packet(bytes: &[u8], index: usize) -> [u8; 8] {
    let mut out = [0xff; 8];
    let start = index * 8;
    let end = (start + 8).min(bytes.len());
    out[..end - start].copy_from_slice(&bytes[start..end]);
    out
}
fn resume_index(status: u8, payload: &[u8; 8], current: usize, retries: usize) -> Result<usize> {
    ensure!(
        [0x0f, 0xf0].contains(&status),
        "Unknown OTA status 0x{status:02x}"
    );
    let next = u16::from_le_bytes([payload[0], payload[1]]) as usize;
    ensure!(
        next <= current && retries <= 30,
        "Invalid/excessive OTA resume request {next}"
    );
    Ok(next)
}
fn transfer(
    bytes: &[u8],
    host: u8,
    uuid: [u8; 8],
    exchange: &mut impl FnMut(u8, u16, [u8; 8]) -> Result<(u8, [u8; 8])>,
    progress: &impl Fn(f32, String),
) -> Result<()> {
    ensure!(
        exchange(11, host as u16, uuid)?.0 == 0,
        "OTA START rejected"
    );
    let count = bytes.len().div_ceil(8);
    let mut info = [0; 8];
    info[..4].copy_from_slice(&(bytes.len() as u32).to_le_bytes());
    info[4..].copy_from_slice(&(count as u32).to_le_bytes());
    ensure!(exchange(12, host as u16, info)?.0 == 0, "OTA INFO rejected");
    let mut index = 0;
    let mut resumes = 0;
    while index < count {
        let (status, payload) = exchange(13, index as u16, packet(bytes, index))?;
        if status == 0 {
            index += 1;
        } else {
            resumes += 1;
            index = resume_index(status, &payload, index, resumes)?;
        }
        if index % 100 == 0 || index == count {
            progress(
                0.95 * index as f32 / count as f32,
                format!("Writing firmware · {index}/{count} packets"),
            );
        }
        thread::sleep(Duration::from_millis(1));
    }
    let mut end = [0; 8];
    end[..4].copy_from_slice(&(count as u32).to_le_bytes());
    ensure!(exchange(14, 0, end)?.0 == 0, "OTA END rejected");
    Ok(())
}

/// Once type 11 is sent this intentionally has no cancel flag. Interrupting
/// an erase/write can leave the motor in its bootloader until a recovery update.
pub fn update(c: &Config, prepared: &Prepared, progress: impl Fn(f32, String)) -> Result<String> {
    ensure!(
        prepared.matches(c),
        "Motor selection changed; prepare firmware again"
    );
    let official = release(&c.profile.model)?;
    let bytes = fs::read(&prepared.path)?;
    verify_image(&bytes, &official)?;
    let dir = bridge::new_run_dir()?;
    bridge::write_json(
        &dir.join("firmware_update.json"),
        &serde_json::json!({
            "release":official,"interface":c.interface,"motor_id":c.motor_id,
            "uuid":prepared.uuid,"previous_version":prepared.current_version,"state":"prepared"
        }),
    )?;
    let bus = Bus::open(c)?;
    let outcome = (|| -> Result<String> {
        progress(0., "Disabling motor before firmware update".into());
        bus.stopped()?;
        // Detect other senders/autoreporting before entering the bootloader.
        bus.flush()?;
        let quiet = Instant::now();
        while quiet.elapsed() < Duration::from_millis(500) {
            ensure!(
                bus.receive()?.is_none(),
                "CAN traffic detected; close other CAN tools and disable periodic reports before updating"
            );
            thread::sleep(Duration::from_millis(1));
        }
        let version = bus.firmware_version()?;
        check_model(&version, &official.model)?;
        ensure!(
            version == prepared.current_version,
            "Firmware changed since preparation; prepare again"
        );
        ensure!(
            bus.ping(c.motor_id, Duration::from_millis(200))? == prepared.uuid,
            "Motor UUID changed; update blocked"
        );
        let mut log = fs::File::create(dir.join("ota_ack.jsonl"))?;
        let mut exchange = |kind: u8, field: u16, payload: [u8; 8]| -> Result<(u8, [u8; 8])> {
            let mut frame = protocol::frame(kind, field, c.motor_id);
            frame.data = payload;
            for attempt in 0..3 {
                bus.send(frame.clone())?;
                match bus.wait_for(Duration::from_secs(2), |f| {
                    ack_result(&f, kind, c.motor_id, c.host_id)
                })? {
                    Some(result) => {
                        writeln!(
                            log,
                            "{}",
                            serde_json::json!({"kind":kind,"field":field,"status":result.0,"data":result.1})
                        )?;
                        return Ok(result);
                    }
                    None => {
                        writeln!(
                            log,
                            "{}",
                            serde_json::json!({"kind":kind,"field":field,"timeout_attempt":attempt})
                        )?;
                        thread::sleep(Duration::from_millis(50));
                    }
                }
            }
            bail!("OTA type {kind}, field {field}: no acknowledgement after 3 attempts")
        };
        progress(
            0.,
            "Entering firmware updater · keep USB and motor power connected".into(),
        );
        transfer(&bytes, c.host_id, prepared.uuid, &mut exchange, &progress)?;
        progress(
            0.97,
            "Transfer acknowledged · verifying restarted application".into(),
        );
        thread::sleep(Duration::from_secs(2));
        let mut installed = None;
        for _ in 0..10 {
            installed = bus.try_firmware_version()?;
            if installed.is_some() {
                break;
            }
            thread::sleep(Duration::from_millis(300));
        }
        let installed = installed.context("Transfer finished but firmware readback timed out; power-cycle the motor and read its version before retrying")?;
        ensure!(
            installed == official.version,
            "Transfer finished but firmware reports {installed}, expected {}",
            official.version
        );
        ensure!(
            bus.ping(c.motor_id, Duration::from_millis(200))? == prepared.uuid,
            "UUID changed after update"
        );
        bus.stopped()?;
        progress(
            1.,
            format!(
                "{} ID {} updated to {installed} · motor stopped",
                official.model, c.motor_id
            ),
        );
        Ok(installed)
    })();
    bridge::write_json(
        &dir.join("firmware_update.json"),
        &serde_json::json!({
            "release":official,"interface":c.interface,"motor_id":c.motor_id,"uuid":prepared.uuid,
            "previous_version":prepared.current_version,
            "state":if outcome.is_ok() {"verified"} else {"failed_or_unverified"},
            "installed_version":outcome.as_ref().ok(),"error":outcome.as_ref().err().map(|e|format!("{e:#}"))
        }),
    )?;
    outcome.with_context(||format!("Firmware update log: {}. If transfer was interrupted, keep the motor stopped and use the vendor OTA recovery procedure", dir.display()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    fn serve_image(status: &str, body: &[u8]) -> (String, thread::JoinHandle<()>) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/image.bin", listener.local_addr().unwrap());
        let status = status.to_owned();
        let body = body.to_vec();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut request = Vec::new();
            let mut buffer = [0; 1024];
            while !request.windows(4).any(|part| part == b"\r\n\r\n") {
                let count = stream.read(&mut buffer).unwrap();
                assert!(count > 0 && request.len() < 8192);
                request.extend_from_slice(&buffer[..count]);
            }
            write!(
                stream,
                "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            )
            .unwrap();
            stream.write_all(&body).unwrap();
        });
        (url, server)
    }

    #[test]
    fn missing_vendor_image_explains_how_to_refresh_the_catalog() {
        let (url, server) = serve_image("404 Not Found", &[]);
        let mut r = release("RS-00").unwrap();
        r.url = url;
        let error = download_image(&r).unwrap_err().to_string();
        assert!(error.contains("RobStride no longer hosts RS-00 firmware"));
        assert!(error.contains(&r.version));
        assert!(error.contains("Check for an app update"));
        server.join().unwrap();
    }

    #[test]
    fn downloaded_images_must_match_the_pinned_digest() {
        let image = vec![1, 2, 3, 4, 5];
        let mut r = release("RS-00").unwrap();
        r.sha256 = Sha256::digest(&image)
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        let (url, server) = serve_image("200 OK", &image);
        r.url = url;
        assert_eq!(download_image(&r).unwrap(), image);
        server.join().unwrap();
        let (url, server) = serve_image("200 OK", &[1, 2, 3, 4, 6]);
        r.url = url;
        assert!(
            download_image(&r)
                .unwrap_err()
                .to_string()
                .contains("SHA-256 mismatch")
        );
        server.join().unwrap();
    }
    #[test]
    fn update_notice_compares_numeric_versions_in_the_same_model() {
        for profile in crate::types::Profile::presets() {
            let r = release(&profile.model).unwrap();
            let [_, family, _, _] = protocol::version_parts(&r.version).unwrap();
            let old = format!("0.{family}.0.0");
            assert_eq!(
                available_update(&profile.model, &old).unwrap().version,
                r.version
            );
            assert!(available_update(&profile.model, &r.version).is_none());
            let future = format!("0.{family}.99.0");
            assert!(available_update(&profile.model, &future).is_none());
        }
        for invalid in ["", "unknown", "0.0.3", "0.0.3.32.1", "0.0.3.256", "0.5.0.1"] {
            assert!(available_update("RS-00", invalid).is_none());
        }
        assert!(available_update("RS-99", "0.0.0.1").is_none());
    }
    #[test]
    fn official_catalog_matches_models_and_rejects_altered_images() {
        for p in crate::types::Profile::presets() {
            let r = release(&p.model).unwrap();
            assert_eq!(protocol::firmware_model(&r.version).unwrap(), p.model);
            assert_eq!(r.sha256.len(), 64);
            assert_eq!(r.url.rsplit('/').next().unwrap(), r.filename);
            assert!(r.url.starts_with(
                "https://github.com/RobStride/Product_Information/releases/download/"
            ));
            assert!(verify_image(&[], &r).is_err());
            assert!(verify_image(&[1; 64], &r).is_err());
        }
        assert!(check_model("0.5.0.14", "RS-00").is_err());
        assert!(check_model("unknown", "RS-00").is_err());
    }
    #[test]
    fn transfer_resumes_without_skipping_bytes_and_rejects_failed_end() {
        let image = (0..19u8).collect::<Vec<_>>();
        let mut seen = Vec::new();
        let mut retried = false;
        let mut sent = Vec::new();
        transfer(
            &image,
            253,
            [7; 8],
            &mut |kind, field, data| {
                seen.push(kind);
                match kind {
                    11 => {
                        assert_eq!(field, 253);
                        assert_eq!(data, [7; 8]);
                    }
                    12 => {
                        assert_eq!(&data[..4], &19u32.to_le_bytes());
                        assert_eq!(&data[4..], &3u32.to_le_bytes());
                    }
                    13 => {
                        if field == 1 && !retried {
                            retried = true;
                            return Ok((0x0f, [0; 8]));
                        }
                        let offset = field as usize * 8;
                        sent.truncate(offset);
                        sent.extend_from_slice(&data);
                    }
                    14 => {
                        assert_eq!(field, 0);
                        assert_eq!(&data[..4], &3u32.to_le_bytes());
                    }
                    _ => panic!("unexpected OTA command"),
                }
                Ok((0, [0; 8]))
            },
            &|_, _| {},
        )
        .unwrap();
        assert_eq!(&seen[..2], &[11, 12]);
        assert_eq!(seen.last(), Some(&14));
        assert_eq!(&sent[..image.len()], &image);
        assert!(sent[image.len()..].iter().all(|b| *b == 255));
        assert!(
            transfer(
                &image,
                253,
                [7; 8],
                &mut |kind, _, _| Ok((if kind == 14 { 0x0f } else { 0 }, [0; 8])),
                &|_, _| {}
            )
            .is_err()
        );
        let mut r = release("RS-00").unwrap();
        r.sha256 = Sha256::digest(&image)
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        assert!(verify_image(&image, &r).is_ok());
        assert!(verify_image(&image[1..], &r).is_err());
    }
    #[test]
    fn ota_filters_acks_and_bounds_resume_requests() {
        let f = protocol::frame(13, 127, 253);
        assert_eq!(ack_result(&f, 13, 127, 253).unwrap().0, 0);
        assert!(ack_result(&f, 12, 127, 253).is_none());
        assert!(ack_result(&f, 13, 7, 253).is_none());
        assert!(ack_result(&f, 13, 127, 1).is_none());
        let mut data = [0; 8];
        data[..2].copy_from_slice(&4u16.to_le_bytes());
        for status in [0x0f, 0xf0] {
            assert_eq!(resume_index(status, &data, 5, 1).unwrap(), 4);
        }
        assert!(resume_index(1, &data, 5, 1).is_err());
        assert!(resume_index(0x0f, &data, 3, 1).is_err());
        assert!(resume_index(0x0f, &data, 5, 31).is_err());
        assert_eq!(
            packet(&[1, 2, 3, 4, 5, 6, 7, 8, 9], 1),
            [9, 255, 255, 255, 255, 255, 255, 255]
        );
    }
}
