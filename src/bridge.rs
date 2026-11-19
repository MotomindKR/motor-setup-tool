use anyhow::{Context, Result};
use serde::{Serialize, de::DeserializeOwned};
use std::{
    fs,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

pub fn new_run_dir() -> Result<PathBuf> {
    let stamp = SystemTime::now().duration_since(UNIX_EPOCH)?.as_millis();
    let path = crate::paths::data_dir()?
        .join("runs")
        .join(format!("{stamp}-{}", std::process::id()));
    fs::create_dir_all(&path)?;
    Ok(path)
}

pub fn lock_recording(dir: &Path) -> Result<fs::File> {
    #[cfg(unix)]
    let lock = fs::File::open(dir)?;
    #[cfg(windows)]
    let lock = {
        use sha2::{Digest, Sha256};
        // Windows locks files. Keep the lock outside the run so deletion can finish.
        let directory = dir.canonicalize().context("Locate recording directory")?;
        let locks = crate::paths::data_dir()?.join("recording-locks");
        fs::create_dir_all(&locks)?;
        let key = Sha256::digest(directory.as_os_str().as_encoded_bytes());
        fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(locks.join(crate::protocol::hex(&key)))?
    };
    lock.try_lock()
        .context("Another operation is using this recording")?;
    Ok(lock)
}
pub fn write_json(path: &Path, value: &impl Serialize) -> Result<()> {
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, serde_json::to_vec_pretty(value)?)?;
    fs::rename(tmp, path)?;
    Ok(())
}
pub fn read_json<T: DeserializeOwned>(path: &Path) -> Result<T> {
    serde_json::from_slice(&fs::read(path).with_context(|| format!("Read {}", path.display()))?)
        .context("Invalid JSON artifact")
}
