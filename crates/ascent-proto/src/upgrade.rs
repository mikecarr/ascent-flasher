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
//! - `recovered: true` means the REBOOT "normal" was seen to take effect: the
//!   device's port went away (the old link errored, or the port was no longer
//!   listed) and it then came back and answered FIND_DEVICE. A device in
//!   clean/upgrade mode also answers FIND_DEVICE, so an answer alone proves
//!   nothing.
//! - The whole post-lock phase (SENDFILE_END, status polls and reconnects) is
//!   bounded by [`UpgradeOptions::writing_timeout`]. When its result can't be
//!   told, the run ends with [`UpgradeError::OutcomeUnknown`], never a reboot.
//! - The device must still be the one the user confirmed
//!   ([`UpgradeError::DeviceChanged`]); this is checked before anything
//!   beyond FIND_DEVICE is sent.

use crate::command::Command;
use crate::discovery::{is_flashable_name, reconnect, reopen_delay_for_vid};
use crate::firmware::{device_version, Firmware, FwVersion};
use crate::frame::Frame;
use crate::link::{Connector, PortInfo};
use crate::payload::{
    file_info, reboot_mode, status_message, DeviceInfo, FileDataInfo, UpgradeStatus,
};
use crate::session::{AckTiming, Session, SessionError};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use thiserror::Error;

/// Largest SENDFILE_DATA chunk we will send, whatever the device reports.
pub const MAX_CHUNK: usize = 1_048_576;

const RECOVERY_HINT: &str = "Power-cycle the VTX (unplug USB and battery). If it doesn't return to normal, recover it with the Caddx Windows tool.";

const OUTCOME_UNKNOWN_HINT: &str = "Check the version with `ascent-flash info` (or reopen the app). If it isn't the new version, flash again.";

#[derive(Clone, Copy, Debug)]
pub struct UpgradeOptions {
    pub timing: AckTiming,
    pub reopen_delay: Duration,
    pub reconnect_timeout: Duration,
    pub reconnect_retry: Duration,
    pub status_poll: Duration,
    pub max_status_polls: u32,
    /// Wall-clock limit for the whole post-lock phase (SENDFILE_END, status
    /// polls and any reconnects in between).
    pub writing_timeout: Duration,
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
            writing_timeout: Duration::from_secs(300),
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
    /// Cancelled before REBOOT "clean": nothing on the device was touched.
    #[error("upgrade cancelled (device unchanged)")]
    CancelledUnchanged,
    #[error("could not reconnect to the device")]
    Reconnect,
    #[error("device did not finish writing the firmware in time")]
    StatusPollLimit,
    /// The device's answer to the first FIND_DEVICE is not the device the user
    /// confirmed. Nothing beyond FIND_DEVICE was sent.
    #[error("the connected device changed since you confirmed — nothing was written")]
    DeviceChanged,
    /// After SENDFILE_END the result could not be told (the device rebooted or
    /// went quiet without reporting 100 %, or the writing phase timed out).
    #[error("flash result unknown — the device now reports {firmware}")]
    OutcomeUnknown { firmware: String },
    /// The firmware is too large for the protocol's 32-bit length field.
    #[error("firmware file is too large ({size} bytes)")]
    FileTooLarge { size: u64 },
    #[error("{cause}{}", recovery_note(*recovered))]
    Failed {
        cause: Box<UpgradeError>,
        recovered: bool,
    },
}

fn recovery_note(recovered: bool) -> &'static str {
    if recovered {
        " (device was rebooted to normal mode and reconnected)"
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
            UpgradeError::OutcomeUnknown { .. } => Some(OUTCOME_UNKNOWN_HINT),
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

/// Whether an UPGRADE_STATUS reply looks like a device still (or done)
/// writing: status 0-3 (VERIFY_IMAGE, START, IN_PROGRESS, DONE) and a sane
/// percent.
fn is_progress(st: &UpgradeStatus) -> bool {
    (0..=3).contains(&st.status) && (0..=100).contains(&st.percent)
}

/// How the post-lock writing phase ended.
enum Written {
    /// UPGRADE_STATUS reached 100 %: wait for the self-reboot, then verify.
    Done,
    /// A post-lock reconnect found the device already on the new firmware
    /// (it finished and rebooted itself before we saw 100 %).
    Rebooted(DeviceInfo),
}

struct Upgrade<'a> {
    conn: &'a dyn Connector,
    opts: &'a UpgradeOptions,
    cancel: &'a CancelToken,
    on: &'a mut dyn FnMut(Progress),
    port: PortInfo,
    session: Option<Session>,
    /// The device the user confirmed.
    expected: &'a DeviceInfo,
    /// Version from the file name (None if unknown).
    file_version: Option<FwVersion>,
    /// Device version from the first FIND_DEVICE, before anything was sent.
    pre_version: Option<FwVersion>,
    /// The most recent FIND_DEVICE reply.
    last_info: Option<DeviceInfo>,
    /// Set once we have decided to send SENDFILE_END; cancel is ignored after.
    locked: bool,
    /// End of the post-lock phase (`writing_timeout` after the lock).
    deadline: Option<Instant>,
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
        self.reconnect_with(delay, self.opts.reconnect_timeout)
    }

    fn reconnect_with(
        &mut self,
        delay: Duration,
        timeout: Duration,
    ) -> Result<DeviceInfo, UpgradeError> {
        self.session = None;
        let (port, session, info) = reconnect(
            self.conn,
            &self.port,
            delay,
            timeout,
            self.opts.reconnect_retry,
            self.opts.timing,
        )?;
        self.port = port;
        self.session = Some(session);
        self.last_info = Some(info.clone());
        Ok(info)
    }

    /// Time left in the post-lock phase (unbounded before the lock).
    fn time_left(&self) -> Duration {
        self.deadline.map_or(Duration::MAX, |d| {
            d.saturating_duration_since(Instant::now())
        })
    }

    fn outcome_unknown(&self) -> UpgradeError {
        let firmware = self
            .last_info
            .as_ref()
            .map_or_else(|| "unknown".to_string(), |i| i.firmware.clone());
        tracing::warn!(%firmware, "flash result unknown");
        UpgradeError::OutcomeUnknown { firmware }
    }

    /// Step 1: open the port and FIND_DEVICE (nothing changed on the device),
    /// and check it is still the device the user confirmed.
    fn find_first(&mut self) -> Result<(), Stop> {
        self.phase(Phase::Rebooting);
        self.checkpoint()?;
        let link = self.conn.open(&self.port.path).map_err(SessionError::Io)?;
        self.session = Some(Session::new(link, self.opts.timing));
        self.checkpoint()?;
        let info = self.session()?.find_device()?;
        tracing::info!(device = %info.device_name, firmware = %info.firmware, "device found");
        let same = is_flashable_name(&info.device_name)
            && info.device_name == self.expected.device_name
            && info.firmware == self.expected.firmware;
        if !same {
            tracing::warn!(found = ?info, expected = ?self.expected, "device changed since confirmation");
            return Err(UpgradeError::DeviceChanged.into());
        }
        self.pre_version = device_version(&info.firmware);
        self.last_info = Some(info);
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
            info = ?info,
            "device back after clean reboot (clean-mode FIND_DEVICE reply)"
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
        let len = u32::try_from(fw.bytes.len()).map_err(|_| UpgradeError::FileTooLarge {
            size: fw.bytes.len() as u64,
        })?;
        let payload = file_info(&fw.md5_hex, len, &remote, &local);
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

    /// Whether `info` shows the new firmware: the file version is known,
    /// differs from the version before the flash, and is what the device
    /// now reports.
    fn shows_new_version(&self, info: &DeviceInfo) -> bool {
        let Some(file) = &self.file_version else {
            return false;
        };
        self.pre_version.as_ref() != Some(file)
            && device_version(&info.firmware).as_ref() == Some(file)
    }

    /// After the lock: drop the link and reconnect WITHOUT any reboot (the
    /// device may be writing flash), within the writing deadline. Then:
    /// - the device already reports the new version → `Some(Rebooted)`;
    /// - otherwise one UPGRADE_STATUS: progress → `None` (keep polling) or
    ///   `Some(Done)` at 100 %; no answer or a non-progress value →
    ///   [`UpgradeError::OutcomeUnknown`].
    ///
    /// Never sends a reboot.
    fn reconnect_after_lock(&mut self, why: &SessionError) -> Result<Option<Written>, Stop> {
        tracing::warn!("transport error after lock ({why}); reconnecting without reboot");
        self.session = None;
        let left = self.time_left();
        if left.is_zero() {
            return Err(self.outcome_unknown().into());
        }
        let delay = self.opts.reopen_delay.min(left);
        let timeout = self.opts.reconnect_timeout.min(left - delay);
        let info = match self.reconnect_with(delay, timeout) {
            Ok(info) => info,
            Err(_) if self.time_left().is_zero() => return Err(self.outcome_unknown().into()),
            Err(e) => return Err(e.into()),
        };
        tracing::info!(info = ?info, "reconnected after lock");
        if self.shows_new_version(&info) {
            tracing::info!(firmware = %info.firmware, "device already reports the new version");
            return Ok(Some(Written::Rebooted(info)));
        }
        let reply = self.session()?.request(Command::UpgradeStatus, &[]);
        let st = match reply.map(|f| UpgradeStatus::decode(&f.payload)) {
            Ok(Ok(st)) => st,
            Ok(Err(e)) => {
                tracing::warn!("undecodable status after reconnect ({e})");
                return Err(self.outcome_unknown().into());
            }
            Err(e) => {
                tracing::warn!("no status after reconnect ({e})");
                return Err(self.outcome_unknown().into());
            }
        };
        tracing::info!(percent = st.percent, status = st.status, detail = %st.detail, "upgrade status after reconnect");
        if !is_progress(&st) {
            return Err(self.outcome_unknown().into());
        }
        self.emit(Progress::Writing {
            percent: st.percent as u8,
        });
        Ok((st.percent >= 100).then_some(Written::Done))
    }

    /// Step 8: SENDFILE_END; must reply status 0 / "OK". Locks cancel and
    /// starts the writing deadline. A lost or garbled reply is not a
    /// rejection: we go on polling. `Some` = the writing phase already ended.
    fn finish(&mut self) -> Result<Option<Written>, Stop> {
        self.phase(Phase::Finishing);
        self.checkpoint()?;
        self.locked = true;
        self.deadline = Some(Instant::now() + self.opts.writing_timeout);
        // Announce the lock BEFORE the request: the reply may take a while and
        // cancel is already ignored.
        self.emit(Progress::CancelLocked);
        let reply = self.session()?.request(Command::SendFileEnd, &[]);
        tracing::info!("SENDFILE_END sent; cancel is now locked");
        let frame = match reply {
            Ok(f) => f,
            Err(e @ (SessionError::Timeout { .. } | SessionError::Io(_))) => {
                return self.reconnect_after_lock(&e);
            }
            Err(e) => {
                tracing::warn!("SENDFILE_END reply unusable ({e}); polling status anyway");
                return Ok(None);
            }
        };
        let reply = match FileDataInfo::decode(&frame.payload) {
            Ok(r) => r,
            Err(e) => {
                tracing::warn!("SENDFILE_END reply undecodable ({e}); polling status anyway");
                return Ok(None);
            }
        };
        if reply.status != 0 || reply.detail != "OK" {
            tracing::warn!(status = reply.status, detail = %reply.detail, "transfer rejected");
            return Err(UpgradeError::TransferRejected(reply.detail).into());
        }
        Ok(None)
    }

    /// Step 9: poll UPGRADE_STATUS until percent >= 100. Transport errors
    /// reconnect (no reboot, see [`Self::reconnect_after_lock`]) and keep
    /// polling within the same budget and the writing deadline.
    fn poll_status(&mut self) -> Result<Written, Stop> {
        self.phase(Phase::Writing);
        for n in 1..=self.opts.max_status_polls {
            let left = self.time_left();
            if left.is_zero() {
                tracing::warn!(poll = n, "writing timeout reached");
                return Err(self.outcome_unknown().into());
            }
            std::thread::sleep(self.opts.status_poll.min(left));
            let f = match self.session()?.request(Command::UpgradeStatus, &[]) {
                Ok(f) => f,
                Err(e @ (SessionError::Timeout { .. } | SessionError::Io(_))) => {
                    match self.reconnect_after_lock(&e)? {
                        Some(w) => return Ok(w),
                        None => continue,
                    }
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
                return Ok(Written::Done);
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
        let written = match self.finish()? {
            Some(w) => w,
            None => self.poll_status()?,
        };
        match written {
            Written::Done => self.verify(),
            Written::Rebooted(info) => {
                self.phase(Phase::Verifying);
                self.session = None;
                tracing::info!(firmware = %info.firmware, port = %self.port.path, "upgrade complete (self-reboot seen on reconnect)");
                Ok(UpgradeOutcome {
                    port: self.port.clone(),
                    info,
                })
            }
        }
    }

    /// After REBOOT "normal": wait up to the reopen delay for the device's
    /// port to go away (no longer listed, or the old link errors). The old
    /// link is probed with FIND_DEVICE only. Returns false if the old link
    /// keeps working (the device ignored the reboot).
    fn wait_for_drop(&mut self) -> bool {
        let deadline = Instant::now() + self.opts.reopen_delay;
        loop {
            match self.conn.list() {
                Ok(ports) if !ports.iter().any(|p| p.path == self.port.path) => {
                    tracing::info!(port = %self.port.path, "recovery: port went away");
                    return true;
                }
                Ok(_) => {}
                Err(e) => tracing::debug!("recovery: port enumeration failed: {e}"),
            }
            if let Some(s) = self.session.as_mut() {
                match s.find_device() {
                    Err(SessionError::Io(e)) => {
                        tracing::info!("recovery: old link dropped ({e})");
                        return true;
                    }
                    Ok(_) => tracing::debug!("recovery: old link still answers"),
                    Err(e) => tracing::debug!("recovery: old link probe failed: {e}"),
                }
            }
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return false;
            }
            std::thread::sleep(self.opts.reconnect_retry.min(left));
        }
    }

    /// REBOOT "normal" and reconnect. Returns whether the device was seen to
    /// reboot (its port went away) and then came back. `link_broken`: the
    /// failure was an I/O error on the current link, so it is dropped and
    /// reopened first (the reboot frame could otherwise be swallowed as the
    /// tail of a partial frame).
    fn recover(&mut self, link_broken: bool) -> bool {
        tracing::info!("recovery: sending REBOOT normal");
        if link_broken && self.session.take().is_some() {
            tracing::info!("recovery: dropping the broken link before REBOOT normal");
        }
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
        let sent_at = Instant::now();
        let dropped = self.wait_for_drop();
        self.session = None;
        if !dropped {
            tracing::warn!(
                "recovery: the device kept its link after REBOOT normal (reboot ignored?)"
            );
            return false;
        }
        let delay = self.opts.reopen_delay.saturating_sub(sent_at.elapsed());
        match self.reconnect(delay) {
            Ok(info) => {
                tracing::info!(info = ?info, "recovery: device rebooted and is back");
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
///
/// `expected` is the device the user confirmed (as shown to them); if the
/// first FIND_DEVICE reports a different name or firmware, nothing else is
/// sent ([`UpgradeError::DeviceChanged`]).
pub fn run_upgrade(
    conn: &dyn Connector,
    port: &PortInfo,
    expected: &DeviceInfo,
    fw: &Firmware,
    opts: &UpgradeOptions,
    cancel: &CancelToken,
    on: &mut dyn FnMut(Progress),
) -> Result<UpgradeOutcome, UpgradeError> {
    tracing::info!(port = %port.path, file = %fw.path.display(), "starting upgrade");
    if u32::try_from(fw.bytes.len()).is_err() {
        return Err(UpgradeError::FileTooLarge {
            size: fw.bytes.len() as u64,
        });
    }
    let mut u = Upgrade {
        conn,
        opts,
        cancel,
        on,
        port: port.clone(),
        session: None,
        expected,
        file_version: fw.version.clone(),
        pre_version: None,
        last_info: None,
        locked: false,
        deadline: None,
    };
    // Before REBOOT "clean": nothing has changed, so no recovery.
    match u.find_first() {
        Ok(()) => {}
        Err(Stop::Cancelled) => return Err(UpgradeError::CancelledUnchanged),
        Err(Stop::Error(e)) => return Err(e),
    }
    match u.after_clean(fw) {
        Ok(outcome) => Ok(outcome),
        Err(Stop::Cancelled) => {
            let recovered = u.recover(false);
            Err(UpgradeError::Cancelled { recovered })
        }
        Err(Stop::Error(e @ UpgradeError::OutcomeUnknown { .. })) => {
            // Never a reboot: the device may be writing or already done.
            Err(e)
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
            let link_broken = matches!(e, UpgradeError::Session(SessionError::Io(_)));
            let recovered = u.recover(link_broken);
            Err(UpgradeError::Failed {
                cause: Box::new(e),
                recovered,
            })
        }
    }
}
