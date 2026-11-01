// AR frame codec and payload layouts (clean-room, from docs/REVERSE_ENGINEERING.md §3).
// 36-byte little-endian header followed by the payload. No DOM use, so Node
// can load it for tests.

export const MAGIC = 0x4152544f;
export const VERSION = 0x0cdc;
export const UNUSED = 0xabcd;
export const HEADER_LEN = 36;
export const MAX_FRAME_LEN = 5120;

export const CMD = {
  REBOOT: 3,
  FIND_DEVICE: 60,
  REMOTE_UPGRADE: 114,
  SENDFILE_START: 115,
  SENDFILE_DATA: 116,
  SENDFILE_END: 117,
  UPGRADE_STATUS: 118,
};

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

function encodeFrame(type, command, payload, seq, retry) {
  const out = new Uint8Array(HEADER_LEN + payload.length);
  const v = new DataView(out.buffer);
  v.setUint32(0, MAGIC, true);
  v.setUint16(4, VERSION, true);
  v.setUint16(6, type, true);
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

/** Encode a request frame (type 1, binary format 2). */
export function encodeRequest(command, payload, seq, retry) {
  return encodeFrame(1, command, payload, seq, retry);
}

/** Encode an ack/reply frame (type 2, binary format 2, retry 0). */
export function encodeAck(command, payload, seq) {
  return encodeFrame(2, command, payload, seq, 0);
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
 * next magic; drops frames with an oversized length; a bad CRC only warns (frame still delivered).
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
        this.onWarn(`CRC mismatch on cmd ${h.command} (ignored)`);
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

const DEVICE_INFO_LEN = 300;
const FILE_INFO_LEN = 328;
const FILE_DATA_INFO_LEN = 80;
const UPGRADE_STATUS_LEN = 72;

function need(b, n) {
  if (b.length < n) throw new Error(`payload too short: need ${n} bytes, got ${b.length}`);
}

function view(b) {
  return new DataView(b.buffer, b.byteOffset, b.length);
}

function str(b, off, len) {
  const f = b.subarray(off, off + len);
  const end = f.indexOf(0);
  return new TextDecoder().decode(end < 0 ? f : f.subarray(0, end));
}

/** Write a string into a fixed-size field, NUL-padded and truncated. */
function putStr(b, off, len, s) {
  b.set(new TextEncoder().encode(s).subarray(0, len), off);
}

/** Decode the 300-byte FIND_DEVICE reply. */
export function decodeDeviceInfo(b) {
  need(b, DEVICE_INFO_LEN);
  const v = view(b);
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

export function encodeDeviceInfo(d) {
  const b = new Uint8Array(DEVICE_INFO_LEN);
  const v = view(b);
  v.setInt32(0, d.receiveMaxSize, true);
  putStr(b, 4, 32, d.sdkVersion);
  putStr(b, 36, 64, d.deviceName);
  v.setInt32(100, d.cpuTemp, true);
  putStr(b, 104, 64, d.firmware);
  putStr(b, 168, 32, d.serialNumber);
  putStr(b, 200, 32, d.hardwareVersion);
  v.setInt32(232, d.status, true);
  putStr(b, 236, 64, d.detail);
  return b;
}

/** Build the 328-byte SENDFILE_START payload (ArFileInfo). */
export function fileInfo(md5Hex, length, remotePath, localDir) {
  const b = new Uint8Array(FILE_INFO_LEN);
  const v = view(b);
  putStr(b, 0, 64, md5Hex);
  v.setUint32(64, length, true);
  v.setInt32(68, 1, true); // saveAsFile
  putStr(b, 72, 128, remotePath);
  const local = Array.from(localDir.replaceAll("\\", "/"));
  putStr(b, 200, 128, local.slice(Math.max(0, local.length - 128)).join(""));
  return b;
}

/** Decode the 80-byte SENDFILE_DATA / SENDFILE_END reply. */
export function decodeFileDataInfo(b) {
  need(b, FILE_DATA_INFO_LEN);
  const v = view(b);
  return {
    length: v.getInt32(0, true),
    cursize: v.getInt32(4, true),
    totalsize: v.getInt32(8, true),
    status: v.getInt32(12, true),
    detail: str(b, 16, 64),
  };
}

export function encodeFileDataInfo(x) {
  const b = new Uint8Array(FILE_DATA_INFO_LEN);
  const v = view(b);
  v.setInt32(0, x.length, true);
  v.setInt32(4, x.cursize, true);
  v.setInt32(8, x.totalsize, true);
  v.setInt32(12, x.status, true);
  putStr(b, 16, 64, x.detail);
  return b;
}

/** Decode the 72-byte UPGRADE_STATUS reply. */
export function decodeUpgradeStatus(b) {
  need(b, UPGRADE_STATUS_LEN);
  const v = view(b);
  return { percent: v.getInt32(0, true), status: v.getInt32(4, true), detail: str(b, 8, 64) };
}

export function encodeUpgradeStatus(x) {
  const b = new Uint8Array(UPGRADE_STATUS_LEN);
  const v = view(b);
  v.setInt32(0, x.percent, true);
  v.setInt32(4, x.status, true);
  putStr(b, 8, 64, x.detail);
  return b;
}

/** REBOOT payload: 32-byte ASCII mode, NUL-padded ("clean" or "normal"). */
export function rebootPayload(mode) {
  const b = new Uint8Array(32);
  putStr(b, 0, 32, mode);
  return b;
}

const STATUS_MESSAGES = {
  [-1]: "Device reports no SD card",
  [-2]: "Device reports no PC connection",
  [-3]: "Device could not find the uploaded file",
  [-4]: "Device rejected the file as bad",
  [-5]: "Wrong model: this firmware is for a different device",
  [-6]: "Firmware version is too old for this device",
  [-7]: "Device is not in upgrade mode",
  [-8]: "Firmware image type is not accepted by this device",
  [-9]: "Firmware image CRC error",
  [-10]: "Device reported an internal upgrade error (max)",
  [-11]: "Flash write error",
  [-12]: "Chip ID mismatch",
};

/** Plain-English message for a negative UPGRADE_STATUS code. */
export function statusMessage(code) {
  return STATUS_MESSAGES[code] ?? "Upgrade failed (unknown error)";
}
