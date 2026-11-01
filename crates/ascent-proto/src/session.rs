//! Request/ack session over a [`Link`], with same-seq resend.

use crate::command::Command;
use crate::frame::{encode_request, Frame};
use crate::link::Link;
use crate::payload::{DeviceInfo, PayloadError};
use crate::reader::FrameReader;
use std::time::{Duration, Instant};
use thiserror::Error;

const POLL: Duration = Duration::from_millis(20);

#[derive(Clone, Copy, Debug)]
pub struct AckTiming {
    pub resend_every: Duration,
    pub give_up_after: Duration,
}

impl Default for AckTiming {
    fn default() -> Self {
        AckTiming {
            resend_every: Duration::from_secs(2),
            give_up_after: Duration::from_secs(8),
        }
    }
}

#[derive(Debug, Error)]
pub enum SessionError {
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
    #[error("timed out waiting for reply to {cmd:?}")]
    Timeout { cmd: Command },
    #[error("bad payload: {0}")]
    Payload(#[from] PayloadError),
}

pub struct Session {
    link: Box<dyn Link>,
    timing: AckTiming,
    reader: FrameReader,
    seq: u32,
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

impl Session {
    pub fn new(link: Box<dyn Link>, timing: AckTiming) -> Self {
        Session {
            link,
            timing,
            reader: FrameReader::new(),
            seq: 0,
        }
    }

    fn next_seq(&mut self) -> u32 {
        let s = self.seq;
        self.seq = self.seq.wrapping_add(1);
        s
    }

    fn send(
        &mut self,
        cmd: Command,
        payload: &[u8],
        seq: u32,
        retry: u32,
    ) -> Result<(), SessionError> {
        let bytes = encode_request(cmd.id(), payload, seq, retry);
        tracing::debug!(cmd = cmd.id(), seq, retry, len = bytes.len(), "send");
        tracing::trace!(hex = %hex(&bytes), "send bytes");
        self.link.write_all(&bytes)?;
        Ok(())
    }

    /// Send without waiting for a reply (e.g. REBOOT).
    pub fn send_no_ack(&mut self, cmd: Command, payload: &[u8]) -> Result<(), SessionError> {
        let seq = self.next_seq();
        self.send(cmd, payload, seq, 0)
    }

    /// Send a request and wait for the frame carrying the same command,
    /// re-sending with the same seq (retry + 1) every `resend_every`.
    pub fn request(&mut self, cmd: Command, payload: &[u8]) -> Result<Frame, SessionError> {
        let seq = self.next_seq();
        let mut retry = 0;
        self.send(cmd, payload, seq, retry)?;
        let start = Instant::now();
        let mut last_send = start;
        let mut buf = [0u8; 1024];
        loop {
            while let Some(f) = self.reader.next_frame() {
                tracing::debug!(
                    cmd = f.header.command,
                    seq = f.header.seq,
                    retry = f.header.retry,
                    len = f.payload.len(),
                    "recv"
                );
                tracing::trace!(hex = %hex(&f.payload), "recv payload");
                if f.header.command == cmd.id() {
                    return Ok(f);
                }
                tracing::debug!(cmd = f.header.command, "ignoring frame for other command");
            }
            let now = Instant::now();
            let until_giveup = self.timing.give_up_after.saturating_sub(now - start);
            if until_giveup.is_zero() {
                return Err(SessionError::Timeout { cmd });
            }
            let mut until_resend = self.timing.resend_every.saturating_sub(now - last_send);
            if until_resend.is_zero() {
                retry += 1;
                self.send(cmd, payload, seq, retry)?;
                last_send = Instant::now();
                until_resend = self.timing.resend_every;
            }
            let wait = POLL.min(until_giveup).min(until_resend);
            let n = self
                .link
                .read_some(&mut buf, wait.max(Duration::from_millis(1)))?;
            self.reader.push(&buf[..n]);
        }
    }

    pub fn find_device(&mut self) -> Result<DeviceInfo, SessionError> {
        let f = self.request(Command::FindDevice, &[])?;
        Ok(DeviceInfo::decode(&f.payload)?)
    }
}
