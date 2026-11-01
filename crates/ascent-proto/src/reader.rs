//! Stream reader that extracts frames from a raw serial byte stream,
//! resynchronising on the magic after garbage or corrupt headers.

use crate::frame::{decode_header, frame_crc, Frame, HEADER_LEN, MAX_FRAME_LEN};

#[derive(Debug, Default)]
pub struct FrameReader {
    buf: Vec<u8>,
}

impl FrameReader {
    pub fn new() -> Self {
        Self::default()
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
                Some(h) if HEADER_LEN + (h.length as usize) <= MAX_FRAME_LEN => h,
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
