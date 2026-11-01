//! Firmware upgrade state machine (spec "Upgrade sequence", steps 1-10) with
//! cancel and recovery.
//!
//! Safety rules:
//! - REBOOT is never acked: it is sent with `send_no_ack` and the old link is
//!   dropped before reconnecting.
//! - Cancel is honoured before every command until the decision to send
//!   SENDFILE_END (117); after that it is ignored ([`Progress::CancelLocked`]).
//! - Once REBOOT "clean" has been sent, a cancel or failure sends REBOOT
//!   "normal" and tries to reconnect ("recovery"). After SENDFILE_END has been
//!   sent, recovery happens only on a device-reported failure (negative status
//!   or rejected transfer); transport errors reconnect without any reboot and
//!   keep polling, and other failures end with `recovered: false`.

use crate::command::Command;
use crate::discovery::{reconnect, reopen_delay_for_vid};
use crate::firmware::Firmware;
use crate::frame::Frame;
use crate::link::{Connector, PortInfo};
use crate::payload::{
    file_info, reboot_mode, status_message, DeviceInfo, FileDataInfo, UpgradeStatus,
};
use crate::session::{AckTiming, Session, SessionError};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use thiserror::Error;

/// Largest SENDFILE_DATA chunk we will send, whatever the device reports.
pub const MAX_CHUNK: usize = 1_048_576;

const RECOVERY_HINT: &str = "Power-cycle the VTX (unplug USB and battery). If it doesn't return to normal, recover it with the Caddx Windows tool.";

#[derive(Clone, Copy, Debug)]
pub struct UpgradeOptions {
    pub timing: AckTiming,
    pub reopen_delay: Duration,
    pub reconnect_timeout: Duration,
    pub reconnect_retry: Duration,
    pub status_poll: Duration,
    pub max_status_polls: u32,
}

impl Default for UpgradeOptions {
    fn default() -> Self {
        UpgradeOptions {
            timing: AckTiming::default(),
            reopen_delay: Duration::from_secs(8),
            reconnect_timeout: Duration::from_secs(200),
            reconnect_retry: Duration::from_secs(1),
            status_poll: Duration::from_secs(1),
            max_status_polls: 200,
        }
    }
}

impl UpgradeOptions {
    /// Defaults, with the reopen delay chosen by the port's USB VID.
    pub fn for_port(port: &PortInfo) -> UpgradeOptions {
        UpgradeOptions {
            reopen_delay: reopen_delay_for_vid(port.vid),
            ..UpgradeOptions::default()
        }
    }
}

#[derive(Clone, Debug, Default)]
pub struct CancelToken(Arc<AtomicBool>);

impl CancelToken {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn cancel(&self) {
        self.0.store(true, Ordering::SeqCst);
    }

    pub fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::SeqCst)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Phase {
    Rebooting,
    Reconnecting,
    EnteringUpgrade,
    StartingTransfer,
    Sending,
    Finishing,
    Writing,
    Restarting,
    Verifying,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Progress {
    Phase(Phase),
    Sent {
        bytes: u64,
        total: u64,
    },
    Writing {
        percent: u8,
    },
    /// SENDFILE_END has been sent: cancel is no longer possible.
    CancelLocked,
}

/// Device state after the final reconnect.
#[derive(Clone, Debug, PartialEq)]
pub struct UpgradeOutcome {
    pub port: PortInfo,
    pub info: DeviceInfo,
}

#[derive(Debug, Error)]
pub enum UpgradeError {
    #[error(transparent)]
    Session(#[from] SessionError),
    #[error("device reported error {code}: {message}")]
    Device { code: i32, message: &'static str },
    #[error("device rejected the transfer: {0}")]
    TransferRejected(String),
    #[error("upgrade cancelled{}", recovery_note(*recovered))]
    Cancelled { recovered: bool },
    #[error("could not reconnect to the device")]
    Reconnect,
    #[error("device did not finish writing the firmware in time")]
    StatusPollLimit,
    #[error("{cause}{}", recovery_note(*recovered))]
    Failed {
        cause: Box<UpgradeError>,
        recovered: bool,
    },
}

fn recovery_note(recovered: bool) -> &'static str {
    if recovered {
        " (device was returned to normal mode)"
    } else {
        ""
    }
}

/// Plain-words text for a progress event, shared by the CLI and GUI.
/// Percent-bearing events (`Sent`, `Writing`) end in `NN%`.
pub fn progress_text(p: &Progress) -> Option<String> {
    Some(match p {
        Progress::Phase(ph) => match ph {
            Phase::Rebooting => "Rebooting into upgrade mode…".into(),
            Phase::Reconnecting => "Reconnecting…".into(),
            Phase::EnteringUpgrade => "Entering upgrade mode…".into(),
            Phase::StartingTransfer => "Starting transfer…".into(),
            Phase::Sending => "Sending firmware… 0%".into(),
            Phase::Finishing => "Finishing transfer…".into(),
            Phase::Writing => "Device is writing firmware… 0%".into(),
            Phase::Restarting => "Restarting…".into(),
            Phase::Verifying => "Verifying…".into(),
        },
        Progress::Sent { bytes, total } => {
            let pct = if *total == 0 {
                100
            } else {
                bytes * 100 / total
            };
            format!("Sending firmware… {pct}%")
        }
        Progress::Writing { percent } => format!("Device is writing firmware… {percent}%"),
        Progress::CancelLocked => "Device is writing firmware — do not unplug".into(),
    })
}

impl UpgradeError {
    /// What the user should do when recovery did not bring the device back.
    pub fn recovery_hint(&self) -> Option<&'static str> {
        match self {
            UpgradeError::Cancelled { recovered: false }
            | UpgradeError::Failed {
                recovered: false, ..
            } => Some(RECOVERY_HINT),
            _ => None,
        }
    }
}

/// Why a phase stopped early.
enum Stop {
    Cancelled,
    Error(UpgradeError),
}

impl From<UpgradeError> for Stop {
    fn from(e: UpgradeError) -> Self {
        Stop::Error(e)
    }
}

impl From<SessionError> for Stop {
    fn from(e: SessionError) -> Self {
        Stop::Error(e.into())
    }
}

impl From<crate::payload::PayloadError> for Stop {
    fn from(e: crate::payload::PayloadError) -> Self {
        Stop::Error(SessionError::from(e).into())
    }
}

/// Chunk size from the device's `receiveMaxSize` (bytes), capped at 1 MiB;
/// 0 (or a nonsensical negative value) means "use the cap".
fn chunk_size(receive_max_size: i32) -> usize {
    if receive_max_size <= 0 {
        MAX_CHUNK
    } else {
        (receive_max_size as usize).min(MAX_CHUNK)
    }
}

/// After the lock, only a device-reported failure means it has stopped
/// writing, so only then is a recovery REBOOT "normal" safe.
fn device_stopped_writing(e: &UpgradeError) -> bool {
    matches!(
        e,
        UpgradeError::Device { .. } | UpgradeError::TransferRejected(_)
    )
}

struct Upgrade<'a> {
    conn: &'a dyn Connector,
    opts: &'a UpgradeOptions,
    cancel: &'a CancelToken,
    on: &'a mut dyn FnMut(Progress),
    port: PortInfo,
    session: Option<Session>,
    /// Set once we have decided to send SENDFILE_END; cancel is ignored after.
    locked: bool,
}

impl Upgrade<'_> {
    fn emit(&mut self, p: Progress) {
        (self.on)(p);
    }

    fn phase(&mut self, p: Phase) {
        tracing::info!(phase = ?p, port = %self.port.path, "upgrade phase");
        self.emit(Progress::Phase(p));
    }

    fn checkpoint(&self) -> Result<(), Stop> {
        if !self.locked && self.cancel.is_cancelled() {
            tracing::info!("cancel requested");
            return Err(Stop::Cancelled);
        }
        Ok(())
    }

    fn session(&mut self) -> Result<&mut Session, Stop> {
        self.session
            .as_mut()
            .ok_or(Stop::Error(UpgradeError::Reconnect))
    }

    /// Cancel checkpoint, then a request on the current session.
    fn request(&mut self, cmd: Command, payload: &[u8]) -> Result<Frame, Stop> {
        self.checkpoint()?;
        Ok(self.session()?.request(cmd, payload)?)
    }

    fn reconnect(&mut self, delay: Duration) -> Result<DeviceInfo, UpgradeError> {
        self.session = None;
        let (port, session, info) = reconnect(
            self.conn,
            &self.port,
            delay,
            self.opts.reconnect_timeout,
            self.opts.reconnect_retry,
            self.opts.timing,
        )?;
        self.port = port;
        self.session = Some(session);
        Ok(info)
    }

    /// Step 1: open the port and FIND_DEVICE (nothing changed on the device).
    fn find_first(&mut self) -> Result<(), Stop> {
        self.phase(Phase::Rebooting);
        self.checkpoint()?;
        let link = self.conn.open(&self.port.path).map_err(SessionError::Io)?;
        self.session = Some(Session::new(link, self.opts.timing));
        let info = self.request(Command::FindDevice, &[])?;
        let info = DeviceInfo::decode(&info.payload)?;
        tracing::info!(device = %info.device_name, firmware = %info.firmware, "device found");
        self.checkpoint()
    }

    /// Steps 2-4: REBOOT "clean" (no ack), drop the link, reconnect.
    /// Returns the chunk size from the second FIND_DEVICE.
    fn reboot_clean(&mut self) -> Result<usize, Stop> {
        tracing::info!("sending REBOOT clean (no ack)");
        self.session()?
            .send_no_ack(Command::Reboot, &reboot_mode("clean"))?;
        self.session = None;
        self.phase(Phase::Reconnecting);
        let info = self.reconnect(self.opts.reopen_delay)?;
        let chunk = chunk_size(info.receive_max_size);
        tracing::info!(
            receive_max_size = info.receive_max_size,
            chunk,
            "device back after clean reboot"
        );
        Ok(chunk)
    }

    /// Step 5: REMOTE_UPGRADE.
    fn enter_upgrade(&mut self) -> Result<(), Stop> {
        self.phase(Phase::EnteringUpgrade);
        self.request(Command::RemoteUpgrade, &[])?;
        Ok(())
    }

    /// Step 6: SENDFILE_START with remote path `/tmp/pc/<basename>`.
    fn start_transfer(&mut self, fw: &Firmware) -> Result<(), Stop> {
        self.phase(Phase::StartingTransfer);
        let base = fw
            .path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        let remote = format!("/tmp/pc/{base}");
        let local = fw.path.to_string_lossy();
        tracing::info!(%remote, md5 = %fw.md5_hex, len = fw.bytes.len(), "SENDFILE_START");
        let payload = file_info(&fw.md5_hex, fw.bytes.len() as u32, &remote, &local);
        self.request(Command::SendFileStart, &payload)?;
        Ok(())
    }

    /// Step 7: SENDFILE_DATA chunks, stop-and-wait.
    fn send_chunks(&mut self, fw: &Firmware, chunk: usize) -> Result<(), Stop> {
        self.phase(Phase::Sending);
        let total = fw.bytes.len() as u64;
        let mut sent = 0u64;
        for (i, part) in fw.bytes.chunks(chunk).enumerate() {
            let f = self.request(Command::SendFileData, part)?;
            sent += part.len() as u64;
            match FileDataInfo::decode(&f.payload) {
                Ok(r) => tracing::debug!(
                    chunk = i,
                    len = part.len(),
                    cursize = r.cursize,
                    status = r.status,
                    "chunk acked"
                ),
                Err(_) => tracing::debug!(chunk = i, len = part.len(), "chunk acked"),
            }
            self.emit(Progress::Sent { bytes: sent, total });
        }
        Ok(())
    }

    /// After the lock: drop the link and reconnect WITHOUT any reboot (the
    /// device may be writing flash). Failure is final (no recovery).
    fn reconnect_without_reboot(&mut self, why: &SessionError) -> Result<(), Stop> {
        tracing::warn!("transport error after lock ({why}); reconnecting without reboot");
        self.session = None;
        self.reconnect(self.opts.reopen_delay)?;
        Ok(())
    }

    /// Step 8: SENDFILE_END; must reply status 0 / "OK". Locks cancel.
    /// A lost or garbled reply is not a rejection: we go on polling.
    fn finish(&mut self) -> Result<(), Stop> {
        self.phase(Phase::Finishing);
        self.checkpoint()?;
        self.locked = true;
        let reply = self.session()?.request(Command::SendFileEnd, &[]);
        tracing::info!("SENDFILE_END sent; cancel is now locked");
        self.emit(Progress::CancelLocked);
        let frame = match reply {
            Ok(f) => f,
            Err(e @ (SessionError::Timeout { .. } | SessionError::Io(_))) => {
                return self.reconnect_without_reboot(&e);
            }
            Err(e) => {
                tracing::warn!("SENDFILE_END reply unusable ({e}); polling status anyway");
                return Ok(());
            }
        };
        let reply = match FileDataInfo::decode(&frame.payload) {
            Ok(r) => r,
            Err(e) => {
                tracing::warn!("SENDFILE_END reply undecodable ({e}); polling status anyway");
                return Ok(());
            }
        };
        if reply.status != 0 || reply.detail != "OK" {
            tracing::warn!(status = reply.status, detail = %reply.detail, "transfer rejected");
            return Err(UpgradeError::TransferRejected(reply.detail).into());
        }
        Ok(())
    }

    /// Step 9: poll UPGRADE_STATUS until percent >= 100. Transport errors
    /// reconnect (no reboot) and keep polling within the same budget.
    fn poll_status(&mut self) -> Result<(), Stop> {
        self.phase(Phase::Writing);
        for n in 1..=self.opts.max_status_polls {
            std::thread::sleep(self.opts.status_poll);
            let f = match self.session()?.request(Command::UpgradeStatus, &[]) {
                Ok(f) => f,
                Err(e @ (SessionError::Timeout { .. } | SessionError::Io(_))) => {
                    self.reconnect_without_reboot(&e)?;
                    continue;
                }
                Err(e) => {
                    tracing::warn!(poll = n, "unusable status reply ({e})");
                    continue;
                }
            };
            let st = match UpgradeStatus::decode(&f.payload) {
                Ok(st) => st,
                Err(e) => {
                    tracing::warn!(poll = n, "undecodable status reply ({e})");
                    continue;
                }
            };
            tracing::info!(poll = n, percent = st.percent, status = st.status, detail = %st.detail, "upgrade status");
            self.emit(Progress::Writing {
                percent: st.percent.clamp(0, 100) as u8,
            });
            if st.status < 0 {
                return Err(UpgradeError::Device {
                    code: st.status,
                    message: status_message(st.status),
                }
                .into());
            }
            if st.percent >= 100 {
                return Ok(());
            }
        }
        Err(UpgradeError::StatusPollLimit.into())
    }

    /// Step 10: the device reboots itself; reconnect and FIND_DEVICE.
    fn verify(&mut self) -> Result<UpgradeOutcome, Stop> {
        self.phase(Phase::Restarting);
        self.session = None;
        std::thread::sleep(self.opts.reopen_delay);
        self.phase(Phase::Verifying);
        let info = self.reconnect(Duration::ZERO)?;
        tracing::info!(firmware = %info.firmware, port = %self.port.path, "upgrade complete");
        Ok(UpgradeOutcome {
            port: self.port.clone(),
            info,
        })
    }

    /// Everything from REBOOT "clean" onwards (steps 2-10).
    fn after_clean(&mut self, fw: &Firmware) -> Result<UpgradeOutcome, Stop> {
        let chunk = self.reboot_clean()?;
        self.enter_upgrade()?;
        self.start_transfer(fw)?;
        self.send_chunks(fw, chunk)?;
        self.finish()?;
        self.poll_status()?;
        self.verify()
    }

    /// REBOOT "normal" and reconnect. Returns whether the device came back.
    fn recover(&mut self) -> bool {
        tracing::info!("recovery: sending REBOOT normal");
        let normal = reboot_mode("normal");
        let sent = match self.session.as_mut() {
            Some(s) => match s.send_no_ack(Command::Reboot, &normal) {
                Ok(()) => true,
                Err(e) => {
                    tracing::info!("recovery: current link unusable ({e}); reconnecting first");
                    false
                }
            },
            None => false,
        };
        if !sent {
            if let Err(e) = self.reconnect(Duration::ZERO) {
                tracing::warn!("recovery failed: {e}");
                self.session = None;
                return false;
            }
            if let Err(e) = self
                .session
                .as_mut()
                .expect("session after reconnect")
                .send_no_ack(Command::Reboot, &normal)
            {
                tracing::warn!("recovery failed to send REBOOT normal: {e}");
                self.session = None;
                return false;
            }
        }
        self.session = None;
        match self.reconnect(self.opts.reopen_delay) {
            Ok(info) => {
                tracing::info!(firmware = %info.firmware, "recovery: device is back");
                self.session = None;
                true
            }
            Err(e) => {
                tracing::warn!("recovery failed: {e}");
                false
            }
        }
    }
}

/// Flash `fw` to the device on `port`. See the module docs for the rules.
pub fn run_upgrade(
    conn: &dyn Connector,
    port: &PortInfo,
    fw: &Firmware,
    opts: &UpgradeOptions,
    cancel: &CancelToken,
    on: &mut dyn FnMut(Progress),
) -> Result<UpgradeOutcome, UpgradeError> {
    tracing::info!(port = %port.path, file = %fw.path.display(), "starting upgrade");
    let mut u = Upgrade {
        conn,
        opts,
        cancel,
        on,
        port: port.clone(),
        session: None,
        locked: false,
    };
    // Before REBOOT "clean": nothing has changed, so no recovery.
    match u.find_first() {
        Ok(()) => {}
        Err(Stop::Cancelled) => return Err(UpgradeError::Cancelled { recovered: true }),
        Err(Stop::Error(e)) => return Err(e),
    }
    match u.after_clean(fw) {
        Ok(outcome) => Ok(outcome),
        Err(Stop::Cancelled) => {
            let recovered = u.recover();
            Err(UpgradeError::Cancelled { recovered })
        }
        Err(Stop::Error(e)) if u.locked && !device_stopped_writing(&e) => {
            // The device may still be writing flash (or has rebooted itself):
            // never send REBOOT "normal" here.
            tracing::warn!("upgrade failed after lock: {e}; no recovery reboot");
            Err(UpgradeError::Failed {
                cause: Box::new(e),
                recovered: false,
            })
        }
        Err(Stop::Error(e)) => {
            tracing::warn!("upgrade failed: {e}");
            let recovered = u.recover();
            Err(UpgradeError::Failed {
                cause: Box::new(e),
                recovered,
            })
        }
    }
}
