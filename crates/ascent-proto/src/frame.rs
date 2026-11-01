//! AR frame: 36-byte little-endian header followed by the payload.

pub const MAGIC: u32 = 0x4152_544F;
pub const VERSION: u16 = 0x0CDC;
pub const UNUSED: u16 = 0xABCD;
pub const HEADER_LEN: usize = 36;
pub const MAX_FRAME_LEN: usize = 5120;

/// Frame header. msgid and userid (always 0) and unused (0xABCD) are implied.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Header {
    pub msg_type: u16,
    pub command: u32,
    pub format: u16,
    pub length: u32,
    pub seq: u32,
    pub retry: u32,
    pub crc32: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Frame {
    pub header: Header,
    pub payload: Vec<u8>,
}

fn u16_at(b: &[u8], off: usize) -> u16 {
    u16::from_le_bytes([b[off], b[off + 1]])
}

fn u32_at(b: &[u8], off: usize) -> u32 {
    u32::from_le_bytes([b[off], b[off + 1], b[off + 2], b[off + 3]])
}

/// CRC-32 over a header (with its crc field zeroed) followed by the payload.
pub fn frame_crc(header36_with_crc_zeroed: &[u8], payload: &[u8]) -> u32 {
    let mut h = crc32fast::Hasher::new();
    h.update(header36_with_crc_zeroed);
    h.update(payload);
    h.finalize()
}

fn encode_frame(msg_type: u16, command: u32, payload: &[u8], seq: u32, retry: u32) -> Vec<u8> {
    let mut out = Vec::with_capacity(HEADER_LEN + payload.len());
    out.extend_from_slice(&MAGIC.to_le_bytes());
    out.extend_from_slice(&VERSION.to_le_bytes());
    out.extend_from_slice(&msg_type.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes()); // msgid
    out.extend_from_slice(&UNUSED.to_le_bytes());
    out.extend_from_slice(&command.to_le_bytes());
    out.extend_from_slice(&2u16.to_le_bytes()); // format: binary
    out.extend_from_slice(&0u16.to_le_bytes()); // userid
    out.extend_from_slice(&(payload.len() as u32).to_le_bytes());
    out.extend_from_slice(&seq.to_le_bytes());
    out.extend_from_slice(&retry.to_le_bytes());
    out.extend_from_slice(&[0; 4]); // crc placeholder
    let crc = frame_crc(&out, payload);
    out[32..36].copy_from_slice(&crc.to_le_bytes());
    out.extend_from_slice(payload);
    out
}

/// Encode a request frame (type 1, binary format 2).
pub fn encode_request(command: u32, payload: &[u8], seq: u32, retry: u32) -> Vec<u8> {
    encode_frame(1, command, payload, seq, retry)
}

/// Encode an ack/reply frame (type 2, binary format 2, retry 0).
pub fn encode_ack(command: u32, payload: &[u8], seq: u32) -> Vec<u8> {
    encode_frame(2, command, payload, seq, 0)
}

/// Decode a 36-byte header. Returns `None` if the magic is wrong.
pub fn decode_header(bytes: &[u8; 36]) -> Option<Header> {
    if u32_at(bytes, 0) != MAGIC {
        return None;
    }
    Some(Header {
        msg_type: u16_at(bytes, 6),
        command: u32_at(bytes, 12),
        format: u16_at(bytes, 16),
        length: u32_at(bytes, 20),
        seq: u32_at(bytes, 24),
        retry: u32_at(bytes, 28),
        crc32: u32_at(bytes, 32),
    })
}
