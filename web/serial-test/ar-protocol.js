// AR frame codec (clean-room, from docs/REVERSE_ENGINEERING.md §3).
// 36-byte little-endian header followed by the payload. No DOM use, so Node
// can load it for tests.

export const MAGIC = 0x4152544f;
export const VERSION = 0x0cdc;
export const UNUSED = 0xabcd;
export const HEADER_LEN = 36;
export const MAX_FRAME_LEN = 5120;

export const CMD = { REBOOT: 3, FIND_DEVICE: 60 };

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** Standard CRC-32 over the given byte arrays, in order. */
export function crc32(...parts) {
  let c = 0xffffffff;
  for (const p of parts) for (let i = 0; i < p.length; i++) c = CRC_TABLE[(c ^ p[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Encode a request frame (type 1, binary format 2). */
export function encodeRequest(command, payload, seq, retry) {
  const out = new Uint8Array(HEADER_LEN + payload.length);
  const v = new DataView(out.buffer);
  v.setUint32(0, MAGIC, true);
  v.setUint16(4, VERSION, true);
  v.setUint16(6, 1, true); // type: request
  v.setUint16(8, 0, true); // msgid
  v.setUint16(10, UNUSED, true);
  v.setUint32(12, command, true);
  v.setUint16(16, 2, true); // format: binary
  v.setUint16(18, 0, true); // userid
  v.setUint32(20, payload.length, true);
  v.setUint32(24, seq, true);
  v.setUint32(28, retry, true);
  v.setUint32(32, crc32(out.subarray(0, HEADER_LEN), payload), true);
  out.set(payload, HEADER_LEN);
  return out;
}

/** Decode a 36-byte header, or null if the magic is wrong. */
export function decodeHeader(b) {
  const v = new DataView(b.buffer, b.byteOffset, HEADER_LEN);
  if (v.getUint32(0, true) !== MAGIC) return null;
  return {
    type: v.getUint16(6, true),
    command: v.getUint32(12, true),
    format: v.getUint16(16, true),
    length: v.getUint32(20, true),
    seq: v.getUint32(24, true),
    retry: v.getUint32(28, true),
    crc32: v.getUint32(32, true),
  };
}

/**
 * Accumulates received bytes and yields whole frames. Skips garbage up to the
 * next magic; drops frames with a bad CRC or an oversized length.
 */
export class FrameReader {
  constructor(onWarn = () => {}) {
    this.buf = new Uint8Array(0);
    this.onWarn = onWarn;
  }

  push(chunk) {
    const b = new Uint8Array(this.buf.length + chunk.length);
    b.set(this.buf);
    b.set(chunk, this.buf.length);
    this.buf = b;
  }

  /** Next complete frame {header, payload}, or null if more bytes are needed. */
  next() {
    for (;;) {
      const start = findMagic(this.buf);
      if (start < 0) {
        this.buf = this.buf.slice(Math.max(0, this.buf.length - 3));
        return null;
      }
      if (start > 0) this.buf = this.buf.slice(start);
      if (this.buf.length < HEADER_LEN) return null;
      const h = decodeHeader(this.buf);
      if (HEADER_LEN + h.length > MAX_FRAME_LEN) {
        this.onWarn(`dropping frame with oversized length ${h.length}`);
        this.buf = this.buf.slice(1);
        continue;
      }
      if (this.buf.length < HEADER_LEN + h.length) return null;
      const head = this.buf.slice(0, HEADER_LEN);
      head.fill(0, 32, 36);
      const payload = this.buf.slice(HEADER_LEN, HEADER_LEN + h.length);
      this.buf = this.buf.slice(HEADER_LEN + h.length);
      if (crc32(head, payload) !== h.crc32) {
        this.onWarn(`CRC mismatch on cmd ${h.command}; frame dropped`);
        continue;
      }
      return { header: h, payload };
    }
  }
}

function findMagic(b) {
  for (let i = 0; i + 4 <= b.length; i++) {
    if (b[i] === 0x4f && b[i + 1] === 0x54 && b[i + 2] === 0x52 && b[i + 3] === 0x41) return i;
  }
  return -1;
}

function str(b, off, len) {
  const f = b.subarray(off, off + len);
  const end = f.indexOf(0);
  return new TextDecoder().decode(end < 0 ? f : f.subarray(0, end));
}

/** Decode the 300-byte FIND_DEVICE reply. */
export function decodeDeviceInfo(b) {
  if (b.length < 300) throw new Error(`device info too short: ${b.length} bytes`);
  const v = new DataView(b.buffer, b.byteOffset, b.length);
  return {
    receiveMaxSize: v.getInt32(0, true),
    sdkVersion: str(b, 4, 32),
    deviceName: str(b, 36, 64),
    cpuTemp: v.getInt32(100, true),
    firmware: str(b, 104, 64),
    serialNumber: str(b, 168, 32),
    hardwareVersion: str(b, 200, 32),
    status: v.getInt32(232, true),
    detail: str(b, 236, 64),
  };
}

/** REBOOT payload: 32-byte ASCII mode, NUL-padded ("clean" or "normal"). */
export function rebootPayload(mode) {
  const b = new Uint8Array(32);
  b.set(new TextEncoder().encode(mode).subarray(0, 32));
  return b;
}

/** Only these device names may be sent the test reboot (as in the app). */
export function isLiteFamily(name) {
  const n = name.toLowerCase();
  return n === "ascent_lite" || n === "ascent_lite_plus";
}

/** USB vendor IDs the Ascent tools treat as candidates. */
export const CANDIDATE_VIDS = [
  ...range(0x1d6b, 0x1d7b),
  ...range(0x1d80, 0x1d84),
];

function range(a, b) {
  const r = [];
  for (let i = a; i <= b; i++) r.push(i);
  return r;
}
