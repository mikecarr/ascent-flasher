//! Fixed-layout payload structs for the AR serial protocol (little-endian).

use thiserror::Error;

#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum PayloadError {
    #[error("payload too short: need {need} bytes, got {got}")]
    TooShort { need: usize, got: usize },
}

const DEVICE_INFO_LEN: usize = 300;
const FILE_INFO_LEN: usize = 328;
const FILE_DATA_INFO_LEN: usize = 80;
const UPGRADE_STATUS_LEN: usize = 72;

fn check(b: &[u8], need: usize) -> Result<(), PayloadError> {
    if b.len() < need {
        Err(PayloadError::TooShort { need, got: b.len() })
    } else {
        Ok(())
    }
}

fn i32_at(b: &[u8], off: usize) -> i32 {
    i32::from_le_bytes([b[off], b[off + 1], b[off + 2], b[off + 3]])
}

fn put_i32(b: &mut [u8], off: usize, v: i32) {
    b[off..off + 4].copy_from_slice(&v.to_le_bytes());
}

/// Read a NUL-terminated ASCII string from a fixed-size field (lossy).
fn str_at(b: &[u8], off: usize, len: usize) -> String {
    let field = &b[off..off + len];
    let end = field.iter().position(|&c| c == 0).unwrap_or(len);
    String::from_utf8_lossy(&field[..end]).into_owned()
}

/// Write a string into a fixed-size field, NUL-padded and truncated.
fn put_str(b: &mut [u8], off: usize, len: usize, s: &str) {
    let n = s.len().min(len);
    b[off..off + n].copy_from_slice(&s.as_bytes()[..n]);
}

/// Reply to FIND_DEVICE (300 bytes).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeviceInfo {
    pub receive_max_size: i32,
    pub sdk_version: String,
    pub device_name: String,
    pub cpu_temp: i32,
    pub firmware: String,
    pub serial_number: String,
    pub hardware_version: String,
    pub status: i32,
    pub detail: String,
}

impl DeviceInfo {
    pub fn decode(b: &[u8]) -> Result<DeviceInfo, PayloadError> {
        check(b, DEVICE_INFO_LEN)?;
        Ok(DeviceInfo {
            receive_max_size: i32_at(b, 0),
            sdk_version: str_at(b, 4, 32),
            device_name: str_at(b, 36, 64),
            cpu_temp: i32_at(b, 100),
            firmware: str_at(b, 104, 64),
            serial_number: str_at(b, 168, 32),
            hardware_version: str_at(b, 200, 32),
            status: i32_at(b, 232),
            detail: str_at(b, 236, 64),
        })
    }

    pub fn encode(&self) -> Vec<u8> {
        let mut b = vec![0u8; DEVICE_INFO_LEN];
        put_i32(&mut b, 0, self.receive_max_size);
        put_str(&mut b, 4, 32, &self.sdk_version);
        put_str(&mut b, 36, 64, &self.device_name);
        put_i32(&mut b, 100, self.cpu_temp);
        put_str(&mut b, 104, 64, &self.firmware);
        put_str(&mut b, 168, 32, &self.serial_number);
        put_str(&mut b, 200, 32, &self.hardware_version);
        put_i32(&mut b, 232, self.status);
        put_str(&mut b, 236, 64, &self.detail);
        b
    }
}

/// Build the 328-byte SENDFILE_START payload (`ArFileInfo`).
pub fn file_info(md5_hex_lower: &str, length: u32, remote_path: &str, local_path: &str) -> Vec<u8> {
    let mut b = vec![0u8; FILE_INFO_LEN];
    put_str(&mut b, 0, 64, md5_hex_lower);
    b[64..68].copy_from_slice(&length.to_le_bytes());
    put_i32(&mut b, 68, 1); // saveAsFile
    put_str(&mut b, 72, 128, remote_path);
    let local = local_path.replace('\\', "/");
    let skip = local.chars().count().saturating_sub(128);
    let tail: String = local.chars().skip(skip).collect();
    put_str(&mut b, 200, 128, &tail);
    b
}

/// Reply to SENDFILE_DATA / SENDFILE_END (80 bytes).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileDataInfo {
    pub length: i32,
    pub cursize: i32,
    pub totalsize: i32,
    pub status: i32,
    pub detail: String,
}

impl FileDataInfo {
    pub fn decode(b: &[u8]) -> Result<FileDataInfo, PayloadError> {
        check(b, FILE_DATA_INFO_LEN)?;
        Ok(FileDataInfo {
            length: i32_at(b, 0),
            cursize: i32_at(b, 4),
            totalsize: i32_at(b, 8),
            status: i32_at(b, 12),
            detail: str_at(b, 16, 64),
        })
    }

    pub fn encode(&self) -> Vec<u8> {
        let mut b = vec![0u8; FILE_DATA_INFO_LEN];
        put_i32(&mut b, 0, self.length);
        put_i32(&mut b, 4, self.cursize);
        put_i32(&mut b, 8, self.totalsize);
        put_i32(&mut b, 12, self.status);
        put_str(&mut b, 16, 64, &self.detail);
        b
    }
}

/// Reply to UPGRADE_STATUS (72 bytes).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UpgradeStatus {
    pub percent: i32,
    pub status: i32,
    pub detail: String,
}

impl UpgradeStatus {
    pub fn decode(b: &[u8]) -> Result<UpgradeStatus, PayloadError> {
        check(b, UPGRADE_STATUS_LEN)?;
        Ok(UpgradeStatus {
            percent: i32_at(b, 0),
            status: i32_at(b, 4),
            detail: str_at(b, 8, 64),
        })
    }

    pub fn encode(&self) -> Vec<u8> {
        let mut b = vec![0u8; UPGRADE_STATUS_LEN];
        put_i32(&mut b, 0, self.percent);
        put_i32(&mut b, 4, self.status);
        put_str(&mut b, 8, 64, &self.detail);
        b
    }
}

/// REBOOT payload: 32-byte ASCII mode, NUL-padded ("clean" or "normal").
pub fn reboot_mode(mode: &str) -> [u8; 32] {
    let mut b = [0u8; 32];
    put_str(&mut b, 0, 32, mode);
    b
}

/// Plain-English message for a negative UPGRADE_STATUS code.
pub fn status_message(code: i32) -> &'static str {
    match code {
        -1 => "Device reports no SD card",
        -2 => "Device reports no PC connection",
        -3 => "Device could not find the uploaded file",
        -4 => "Device rejected the file as bad",
        -5 => "Wrong model: this firmware is for a different device",
        -6 => "Firmware version is too old for this device",
        -7 => "Device is not in upgrade mode",
        -8 => "Firmware image type is not accepted by this device",
        -9 => "Firmware image CRC error",
        -10 => "Device reported an internal upgrade error (max)",
        -11 => "Flash write error",
        -12 => "Chip ID mismatch",
        _ => "Upgrade failed (unknown error)",
    }
}
