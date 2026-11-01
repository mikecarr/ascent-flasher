//! Firmware pre-flight: pure checks on a file and `DeviceInfo`; touches no device.

use crate::discovery::is_flashable_name;
use crate::payload::DeviceInfo;
use md5::{Digest, Md5};
use regex::Regex;
use std::fmt;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

const MAX_PATH_CHARS: usize = 200;

/// Largest firmware file accepted (Ascent images are at most about 180 MB).
pub const MAX_FIRMWARE_BYTES: u64 = 256 * 1024 * 1024;

/// Device-side directory for the uploaded file (`/tmp/pc/<basename>`).
pub const REMOTE_DIR: &str = "/tmp/pc/";

/// The remote path goes into a 128-byte field that must keep a NUL.
const MAX_REMOTE_PATH_BYTES: usize = 127;

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct FwVersion {
    pub major: u32,
    pub minor: u32,
    pub patch: u32,
    pub extra: Option<u32>,
}

impl fmt::Display for FwVersion {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "V{}.{}.{}", self.major, self.minor, self.patch)?;
        if let Some(e) = self.extra {
            write!(f, ".{e}")?;
        }
        Ok(())
    }
}

fn file_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?i)^.*?(\d+)_(\d+)_(\d+)(?:(?:_z8_|_z40_|_hub_)(\d+))?\.img$").unwrap()
    })
}

fn device_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(\d+)_(\d+)_(\d+)$").unwrap())
}

fn version_from(c: &regex::Captures<'_>) -> Option<FwVersion> {
    let n = |i: usize| c.get(i).map(|m| m.as_str().parse::<u32>());
    Some(FwVersion {
        major: n(1)?.ok()?,
        minor: n(2)?.ok()?,
        patch: n(3)?.ok()?,
        extra: match n(4) {
            Some(r) => Some(r.ok()?),
            None => None,
        },
    })
}

/// Version encoded in a firmware file name, e.g. `Ascent_Lite_Plus_1_3_0.img`.
pub fn file_version(file_name: &str) -> Option<FwVersion> {
    version_from(&file_re().captures(file_name)?)
}

/// Version at the end of the device's `firmwareInfo`, e.g. `Ascent_H_Sky_17_5_8`.
pub fn device_version(firmware: &str) -> Option<FwVersion> {
    version_from(&device_re().captures(firmware)?)
}

/// Original-case prefix tokens of the device firmware (trailing numeric tokens
/// up to three, and `ascent`, removed).
fn prefix_tokens(firmware: &str) -> Vec<&str> {
    let mut toks: Vec<&str> = firmware.split('_').collect();
    for _ in 0..3 {
        if toks
            .last()
            .is_some_and(|t| !t.is_empty() && t.bytes().all(|b| b.is_ascii_digit()))
        {
            toks.pop();
        }
    }
    toks.retain(|t| !t.eq_ignore_ascii_case("ascent") && !t.is_empty());
    toks
}

fn normalize(s: &str) -> String {
    let mut s = s.to_lowercase();
    if let Some(stem) = s.strip_suffix(".img") {
        s = stem.to_string();
    }
    s.replace(['-', ' ', '.'], "_")
}

/// Does the file name carry the device's model prefix, followed by a number?
pub fn name_matches(file_name: &str, firmware: &str) -> bool {
    let prefix: Vec<String> = prefix_tokens(firmware)
        .iter()
        .map(|t| normalize(t))
        .collect();
    if prefix.is_empty() {
        return true;
    }
    let file = normalize(file_name);
    let ftoks: Vec<&str> = file.split('_').collect();
    (0..ftoks.len()).any(|i| {
        let end = i + prefix.len();
        end < ftoks.len()
            && ftoks[i..end].iter().zip(&prefix).all(|(a, b)| a == b)
            && !ftoks[end].is_empty()
            && ftoks[end].bytes().all(|b| b.is_ascii_digit())
    })
}

#[derive(Debug)]
pub struct Firmware {
    pub path: PathBuf,
    pub bytes: Vec<u8>,
    pub md5_hex: String,
    pub version: Option<FwVersion>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Warning {
    Downgrade { from: FwVersion, to: FwVersion },
    NameMismatch { expected: String },
    UnknownVersion,
}

/// Plain-words text for a warning (no trailing question), shared by the CLI and GUI.
pub fn warning_text(w: &Warning) -> String {
    match w {
        Warning::Downgrade { from, to } => format!(
            "The file ({to}) is older than the device ({from}). Downgrading usually fails."
        ),
        Warning::NameMismatch { expected } => format!(
            "This file name doesn't look like firmware for this device (expected '{expected}' in the name)."
        ),
        Warning::UnknownVersion => "Couldn't read a version from the file name.".to_string(),
    }
}

#[derive(Debug, thiserror::Error)]
pub enum PreflightError {
    #[error("device {0:?} is not a flashable Ascent model")]
    NotFlashable(String),
    #[error("file path is longer than {MAX_PATH_CHARS} characters")]
    PathTooLong,
    #[error("firmware file must have a .img extension")]
    NotImg,
    #[error("cannot read firmware file: {0}")]
    Unreadable(std::io::Error),
    #[error("firmware file is empty")]
    Empty,
    #[error("firmware file is too large ({} MB) — Ascent images are at most about 180 MB; is this the right file?", size / 1_000_000)]
    TooLarge { size: u64 },
    #[error("rename the file to a shorter ASCII name, e.g. Ascent_H_Sky_18_21_10.img")]
    BadFileName,
}

/// Whether the file's basename can be sent as `/tmp/pc/<basename>`:
/// printable ASCII, and the whole remote path fits the 128-byte field with
/// its NUL terminator.
fn remote_name_ok(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
        return false;
    };
    !name.is_empty()
        && name.bytes().all(|b| (0x20..=0x7E).contains(&b))
        && REMOTE_DIR.len() + name.len() <= MAX_REMOTE_PATH_BYTES
}

pub fn preflight(
    info: &DeviceInfo,
    path: &Path,
) -> Result<(Firmware, Vec<Warning>), PreflightError> {
    if !is_flashable_name(&info.device_name) {
        return Err(PreflightError::NotFlashable(info.device_name.clone()));
    }
    if path.to_string_lossy().chars().count() > MAX_PATH_CHARS {
        return Err(PreflightError::PathTooLong);
    }
    let is_img = path
        .extension()
        .is_some_and(|e| e.eq_ignore_ascii_case("img"));
    if !is_img {
        return Err(PreflightError::NotImg);
    }
    if !remote_name_ok(path) {
        return Err(PreflightError::BadFileName);
    }
    // Size check BEFORE reading, so a huge file is never loaded.
    let size = std::fs::metadata(path)
        .map_err(PreflightError::Unreadable)?
        .len();
    if size > MAX_FIRMWARE_BYTES {
        return Err(PreflightError::TooLarge { size });
    }
    let bytes = std::fs::read(path).map_err(PreflightError::Unreadable)?;
    if bytes.is_empty() {
        return Err(PreflightError::Empty);
    }
    // The file may have changed since the metadata check.
    if bytes.len() as u64 > MAX_FIRMWARE_BYTES {
        return Err(PreflightError::TooLarge {
            size: bytes.len() as u64,
        });
    }
    let md5_hex = Md5::digest(&bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>();

    let file_name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let version = file_version(&file_name);
    let mut warnings = Vec::new();
    match (&version, device_version(&info.firmware)) {
        (None, _) => warnings.push(Warning::UnknownVersion),
        (Some(to), Some(from)) if *to < from => warnings.push(Warning::Downgrade {
            from,
            to: to.clone(),
        }),
        _ => {}
    }
    if !name_matches(&file_name, &info.firmware) {
        warnings.push(Warning::NameMismatch {
            expected: prefix_tokens(&info.firmware).join("_"),
        });
    }
    Ok((
        Firmware {
            path: path.to_path_buf(),
            bytes,
            md5_hex,
            version,
        },
        warnings,
    ))
}
