//! Stream reader that extracts frames from a raw serial byte stream,
//! resynchronising on the magic after garbage or corrupt headers.

use crate::frame::{decode_header, frame_crc, Frame, HEADER_LEN, MAX_FRAME_LEN};

#[derive(Debug)]
pub struct FrameReader {
    buf: Vec<u8>,
    max_len: usize,
}

impl Default for FrameReader {
    fn default() -> Self {
        Self::with_max_len(MAX_FRAME_LEN)
    }
}

impl FrameReader {
    /// Reader for frames received by the host (at most [`MAX_FRAME_LEN`]).
    pub fn new() -> Self {
        Self::default()
    }

    /// Reader accepting frames of up to `max_len` bytes including the header
    /// (e.g. the device side of the simulator, which receives large chunks).
    pub fn with_max_len(max_len: usize) -> Self {
        FrameReader {
            buf: Vec::new(),
            max_len,
        }
    }

    pub fn push(&mut self, bytes: &[u8]) {
        self.buf.extend_from_slice(bytes);
    }

    /// Return the next complete frame, if any. CRC is not enforced: a mismatch
    /// only logs a warning.
    pub fn next_frame(&mut self) -> Option<Frame> {
        loop {
            if self.buf.len() < HEADER_LEN {
                return None;
            }
            let head: [u8; HEADER_LEN] = self.buf[..HEADER_LEN].try_into().ok()?;
            let header = match decode_header(&head) {
                Some(h) if HEADER_LEN + (h.length as usize) <= self.max_len => h,
                _ => {
                    self.buf.drain(..1);
                    continue;
                }
            };
            let total = HEADER_LEN + header.length as usize;
            if self.buf.len() < total {
                return None;
            }
            let payload = self.buf[HEADER_LEN..total].to_vec();
            let mut zeroed = head;
            zeroed[32..36].fill(0);
            let crc = frame_crc(&zeroed, &payload);
            if crc != header.crc32 {
                tracing::warn!(
                    expected = header.crc32,
                    computed = crc,
                    command = header.command,
                    "frame CRC mismatch (ignored)"
                );
            }
            self.buf.drain(..total);
            return Some(Frame { header, payload });
        }
    }
}
