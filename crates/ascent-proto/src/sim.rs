//! In-memory device simulator (feature `sim`) for tests of higher layers.
//!
//! Observability: `log` holds the header of every request received (including
//! dropped ones, in order); `received_requests` holds `(header, payload)` for
//! the same requests, so tests can inspect e.g. the 115 file-info payload.
//! Offline windows are wall-clock based (`Instant`). A device that goes
//! offline (REBOOT, or self-reboot after reporting percent >= 100) breaks every
//! link that was open at that time (BrokenPipe once buffered replies are
//! drained), even after the device reappears; reopen via the connector.

use crate::command::Command;
use crate::frame::{encode_ack, Header};
use crate::link::{Connector, Link, PortInfo};
use crate::payload::{DeviceInfo, FileDataInfo, UpgradeStatus};
use crate::reader::FrameReader;
use std::collections::VecDeque;
use std::io;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

pub struct SimDevice {
    pub info: DeviceInfo,
    /// Popped front-first for UPGRADE_STATUS; when empty replies {100, 3, "OK"}.
    pub status_script: Vec<UpgradeStatus>,
    /// Ignore (no reply) this many incoming requests.
    pub drop_first_requests: u32,
    pub log: Vec<Header>,
    pub received_requests: Vec<(Header, Vec<u8>)>,
    pub received_file: Vec<u8>,
    /// NUL-trimmed mode strings of REBOOT requests.
    pub reboot_modes: Vec<String>,
    /// Detail string in the SENDFILE_END reply.
    pub end_detail: String,
    pub reboot_moves_to: Option<String>,
    pub offline_for: Duration,
    /// After this many 116 chunks are acked the device is permanently gone.
    pub unplug_after_data_chunks: Option<u32>,
    chunks_acked: u32,
    path: String,
    offline_until: Option<Instant>,
    gone: bool,
    epoch: u64,
}

impl Default for SimDevice {
    fn default() -> Self {
        SimDevice {
            info: DeviceInfo {
                receive_max_size: 4096,
                sdk_version: "1.0.0".into(),
                device_name: "ascent_lite_plus".into(),
                cpu_temp: 42,
                firmware: "Ascent_Lite_Plus_1_2_3".into(),
                serial_number: "SIM0001".into(),
                hardware_version: "V1.0".into(),
                status: 0,
                detail: "OK".into(),
            },
            status_script: Vec::new(),
            drop_first_requests: 0,
            log: Vec::new(),
            received_requests: Vec::new(),
            received_file: Vec::new(),
            reboot_modes: Vec::new(),
            end_detail: "OK".into(),
            reboot_moves_to: None,
            offline_for: Duration::from_millis(10),
            unplug_after_data_chunks: None,
            chunks_acked: 0,
            path: String::new(),
            offline_until: None,
            gone: false,
            epoch: 0,
        }
    }
}

impl SimDevice {
    pub fn lite_plus() -> Self {
        Self::default()
    }

    /// Current port path (changes on reboot if `reboot_moves_to` is set).
    pub fn path(&self) -> &str {
        &self.path
    }

    fn refresh(&mut self) {
        if let Some(t) = self.offline_until {
            if Instant::now() >= t {
                self.offline_until = None;
            }
        }
    }

    fn online(&mut self) -> bool {
        self.refresh();
        !self.gone && self.offline_until.is_none()
    }

    fn go_offline(&mut self) {
        self.epoch += 1;
        self.offline_until = Some(Instant::now() + self.offline_for);
        if let Some(p) = &self.reboot_moves_to {
            self.path = p.clone();
        }
    }

    /// Process one request; returns reply bytes if any.
    fn handle(&mut self, h: Header, payload: Vec<u8>) -> Option<Vec<u8>> {
        self.log.push(h);
        self.received_requests.push((h, payload.clone()));
        if self.drop_first_requests > 0 {
            self.drop_first_requests -= 1;
            return None;
        }
        let ack = |p: &[u8]| Some(encode_ack(h.command, p, h.seq));
        let fd = |length: usize, cur: usize, detail: &str| {
            FileDataInfo {
                length: length as i32,
                cursize: cur as i32,
                totalsize: 0,
                status: 0,
                detail: detail.to_string(),
            }
            .encode()
        };
        match h.command {
            c if c == Command::Reboot.id() => {
                let end = payload
                    .iter()
                    .position(|&b| b == 0)
                    .unwrap_or(payload.len());
                self.reboot_modes
                    .push(String::from_utf8_lossy(&payload[..end]).into_owned());
                self.go_offline();
                None
            }
            c if c == Command::FindDevice.id() => ack(&self.info.encode()),
            c if c == Command::RemoteUpgrade.id() => ack(&[]),
            c if c == Command::SendFileStart.id() => {
                self.received_file.clear();
                ack(&[])
            }
            c if c == Command::SendFileData.id() => {
                self.received_file.extend_from_slice(&payload);
                let reply = ack(&fd(payload.len(), self.received_file.len(), "OK"));
                self.chunks_acked += 1;
                if self
                    .unplug_after_data_chunks
                    .is_some_and(|n| self.chunks_acked >= n)
                {
                    self.gone = true;
                    self.epoch += 1;
                }
                reply
            }
            c if c == Command::SendFileEnd.id() => {
                let d = self.end_detail.clone();
                ack(&fd(0, 0, &d))
            }
            c if c == Command::UpgradeStatus.id() => {
                let st = if self.status_script.is_empty() {
                    UpgradeStatus {
                        percent: 100,
                        status: 3,
                        detail: "OK".into(),
                    }
                } else {
                    self.status_script.remove(0)
                };
                let reply = ack(&st.encode());
                if st.percent >= 100 {
                    self.go_offline();
                }
                reply
            }
            other => {
                tracing::debug!(cmd = other, "sim: unknown command ignored");
                None
            }
        }
    }
}

pub struct SimConnector {
    pub device: Arc<Mutex<SimDevice>>,
    vid: u16,
    pid: u16,
}

impl SimConnector {
    pub fn new(path: &str, vid: u16, pid: u16, mut device: SimDevice) -> Self {
        device.path = path.to_string();
        SimConnector {
            device: Arc::new(Mutex::new(device)),
            vid,
            pid,
        }
    }
}

impl Connector for SimConnector {
    fn list(&self) -> io::Result<Vec<PortInfo>> {
        let mut d = self.device.lock().unwrap();
        if !d.online() {
            return Ok(vec![]);
        }
        Ok(vec![PortInfo {
            path: d.path.clone(),
            vid: self.vid,
            pid: self.pid,
            serial: Some(d.info.serial_number.clone()),
        }])
    }

    fn open(&self, path: &str) -> io::Result<Box<dyn Link>> {
        let mut d = self.device.lock().unwrap();
        if !d.online() || d.path != path {
            return Err(io::Error::new(io::ErrorKind::NotFound, "no such port"));
        }
        Ok(Box::new(SimLink {
            device: self.device.clone(),
            epoch: d.epoch,
            reader: FrameReader::new(),
            rx: VecDeque::new(),
        }))
    }
}

struct SimLink {
    device: Arc<Mutex<SimDevice>>,
    epoch: u64,
    reader: FrameReader,
    rx: VecDeque<u8>,
}

fn broken() -> io::Error {
    io::Error::new(io::ErrorKind::BrokenPipe, "device disconnected")
}

impl SimLink {
    fn alive(&self, d: &mut SimDevice) -> bool {
        d.online() && d.epoch == self.epoch
    }
}

impl Link for SimLink {
    fn write_all(&mut self, buf: &[u8]) -> io::Result<()> {
        let mut d = self.device.lock().unwrap();
        if !self.alive(&mut d) {
            return Err(broken());
        }
        self.reader.push(buf);
        while let Some(f) = self.reader.next_frame() {
            if let Some(reply) = d.handle(f.header, f.payload) {
                self.rx.extend(reply);
            }
        }
        Ok(())
    }

    fn read_some(&mut self, buf: &mut [u8], timeout: Duration) -> io::Result<usize> {
        if self.rx.is_empty() {
            std::thread::sleep(timeout);
            if self.rx.is_empty() {
                let mut d = self.device.lock().unwrap();
                return if self.alive(&mut d) {
                    Ok(0)
                } else {
                    Err(broken())
                };
            }
        }
        let n = buf.len().min(self.rx.len());
        for b in buf.iter_mut().take(n) {
            *b = self.rx.pop_front().unwrap();
        }
        Ok(n)
    }
}
